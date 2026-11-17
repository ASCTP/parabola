import { randomUUID } from "node:crypto";
import { TransferError } from "../errors.js";
import type {
  SettlementKernel,
  TransferProgress,
  TransferRunOptions,
} from "../kernel/contracts.js";
import { TransferProgressError } from "../kernel/errors.js";
import type {
  CompleteMintParams,
  TransferParams,
  TransferResult,
} from "../types.js";
import type { TransferRecord, TransferStore } from "./contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferLeaseLostError,
  TransferPersistenceError,
} from "./errors.js";
import { resultFromRecord } from "./record.js";

const DEFAULT_LEASE_MS = 15 * 60_000;

export interface ExecuteTransferOptions {
  idempotencyKey: string;
  owner?: string;
  leaseMs?: number;
}

export interface ExecuteTransferOutcome {
  record: TransferRecord;
  result: TransferResult;
}

function sourceAddressFor(params: TransferParams): string | undefined {
  if (params.from === "arc") {
    const account = params.signer.walletClient.account;
    if (!account) {
      return undefined;
    }
    return typeof account === "string" ? account : account.address;
  }
  return params.signer.publicKey;
}

function isResumable(record: TransferRecord): boolean {
  return (
    record.burnTxHash !== undefined &&
    (record.phase === "burned" ||
      record.phase === "attesting" ||
      record.phase === "attested" ||
      record.phase === "recoverable")
  );
}

function sameSourceAddress(
  record: TransferRecord,
  params: TransferParams,
): boolean {
  const sourceAddress = sourceAddressFor(params);
  if (record.sourceAddress === undefined || sourceAddress === undefined) {
    return true;
  }
  return (
    record.sourceAddress === sourceAddress ||
    record.sourceAddress.toLowerCase() === sourceAddress.toLowerCase()
  );
}

function assertSameTransfer(
  record: TransferRecord,
  params: TransferParams,
): void {
  const network = params.network ?? "mainnet";
  if (
    record.from !== params.from ||
    record.to !== params.to ||
    record.network !== network ||
    record.amount !== params.amount ||
    record.recipient !== params.recipient ||
    !sameSourceAddress(record, params)
  ) {
    throw new TransferConflictError("mismatch", record);
  }
}

async function replayTransfer(
  store: TransferStore,
  record: TransferRecord,
  result: TransferResult,
): Promise<ExecuteTransferOutcome> {
  if (!record.result) {
    record.result = result;
    try {
      await store.put(record);
    } catch (err) {
      throw new TransferPersistenceError(
        "Failed to persist replayed transfer state",
        record,
        result,
        { cause: err },
      );
    }
  }
  return { record, result };
}

function applyProgress(
  record: TransferRecord,
  progress: TransferProgress,
): void {
  record.phase = progress.phase;
  if (progress.burnTxHash !== undefined) {
    record.burnTxHash = progress.burnTxHash;
  }
  if (progress.attestationHash !== undefined) {
    record.attestationHash = progress.attestationHash;
  }
  if (progress.mintTxHash !== undefined) {
    record.mintTxHash = progress.mintTxHash;
  }
  if (progress.transferMode !== undefined) {
    record.transferMode = progress.transferMode;
  }
  if (progress.fee !== undefined) {
    record.fee = progress.fee;
  }
  record.updatedAt = Date.now();
}

function progressWriter(
  store: TransferStore,
  record: TransferRecord,
  owner: string,
  leaseMs: number,
): NonNullable<TransferRunOptions["onProgress"]> {
  return async (progress) => {
    const renewed = await store.renew(record.idempotencyKey, owner, leaseMs);
    if (!renewed) {
      throw new TransferLeaseLostError(record.idempotencyKey);
    }
    applyProgress(record, progress);
    try {
      await store.put(record);
    } catch (err) {
      throw new TransferPersistenceError(
        "Failed to persist transfer progress",
        record,
        undefined,
        { cause: err },
      );
    }
  };
}

function rethrowProgressError(
  err: unknown,
  record: TransferRecord,
): void {
  if (err instanceof TransferProgressError) {
    if (
      err.cause instanceof TransferPersistenceError ||
      err.cause instanceof TransferLeaseLostError
    ) {
      throw err.cause;
    }
    throw new TransferPersistenceError(
      "Transfer progress handler failed",
      record,
      undefined,
      { cause: err.cause },
    );
  }
}

async function persistFailure(
  store: TransferStore,
  record: TransferRecord,
  result?: TransferResult,
): Promise<void> {
  try {
    await store.put(record);
  } catch (err) {
    throw new TransferPersistenceError(
      "Failed to persist transfer failure state",
      record,
      result,
      { cause: err },
    );
  }
}

async function resumeTransfer(
  kernel: SettlementKernel,
  store: TransferStore,
  record: TransferRecord,
  params: TransferParams,
  owner: string,
  leaseMs: number,
): Promise<ExecuteTransferOutcome> {
  const destinationSigner = params.options?.destinationSigner;
  if (!destinationSigner) {
    throw new TransferConflictError("recoverable", record);
  }

  const resumeParams = {
    from: record.from,
    to: record.to,
    burnTxHash: record.burnTxHash,
    network: record.network,
    signer: destinationSigner,
    options: params.options,
  } as unknown as CompleteMintParams;

  let completed;
  try {
    completed = await kernel.completeMint(resumeParams, {
      onProgress: progressWriter(store, record, owner, leaseMs),
    });
  } catch (err) {
    rethrowProgressError(err, record);
    record.phase = "recoverable";
    record.error = err instanceof Error ? err.message : String(err);
    record.updatedAt = Date.now();
    await persistFailure(store, record);
    throw err;
  }

  const result: TransferResult = {
    status: "success",
    transferMode: record.transferMode ?? "standard",
    burnTxHash: record.burnTxHash ?? "",
    attestationHash: completed.attestationHash,
    mintTxHash: completed.mintTxHash,
    fee: record.fee ?? "0",
    durationMs: Date.now() - record.createdAt,
  };
  record.phase = "minted";
  record.attestationHash = completed.attestationHash;
  record.mintTxHash = completed.mintTxHash;
  record.result = result;
  delete record.error;
  record.updatedAt = Date.now();

  try {
    await store.put(record);
  } catch (err) {
    throw new TransferPersistenceError(
      "Failed to persist recovered transfer state",
      record,
      result,
      { cause: err },
    );
  }

  return { record, result };
}

async function resolveClaimedRecord(
  kernel: SettlementKernel,
  store: TransferStore,
  record: TransferRecord,
  params: TransferParams,
  owner: string,
  leaseMs: number,
): Promise<ExecuteTransferOutcome> {
  assertSameTransfer(record, params);
  const replayed = resultFromRecord(record);
  if (replayed) {
    return replayTransfer(store, record, replayed);
  }
  if (isResumable(record)) {
    return resumeTransfer(kernel, store, record, params, owner, leaseMs);
  }
  if (record.phase === "recoverable") {
    throw new TransferConflictError("recoverable", record);
  }
  if (record.phase === "failed") {
    throw new TransferConflictError("failed", record);
  }
  throw new TransferConflictError("in_progress", record);
}

export async function executeTransfer(
  kernel: SettlementKernel,
  store: TransferStore,
  params: TransferParams,
  options: ExecuteTransferOptions,
): Promise<ExecuteTransferOutcome> {
  const idempotencyKey = options.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new InvalidIdempotencyKeyError();
  }
  const owner = options.owner ?? randomUUID();
  const leaseMs =
    options.leaseMs ??
    Math.max(DEFAULT_LEASE_MS, (params.options?.pollTimeout ?? 0) + 60_000);

  const observed = await store.get(idempotencyKey);
  if (observed) {
    assertSameTransfer(observed, params);
    const replayed = resultFromRecord(observed);
    if (replayed) {
      return replayTransfer(store, observed, replayed);
    }
  }

  const claim = await store.claim(idempotencyKey, owner, leaseMs);
  if (claim.status === "busy") {
    const record = claim.record ?? (await store.get(idempotencyKey));
    if (!record) {
      throw new Error(`Transfer ${idempotencyKey} disappeared from the store`);
    }
    assertSameTransfer(record, params);
    if (
      record.result &&
      (record.phase === "minted" || record.phase === "pending")
    ) {
      return { record, result: record.result };
    }
    throw new TransferConflictError("in_progress", record);
  }

  try {
    if (claim.record) {
      return await resolveClaimedRecord(
        kernel,
        store,
        claim.record,
        params,
        owner,
        leaseMs,
      );
    }

    const now = Date.now();
    const record: TransferRecord = {
      idempotencyKey,
      phase: "planned",
      from: params.from,
      to: params.to,
      network: params.network ?? "mainnet",
      amount: params.amount,
      recipient: params.recipient,
      sourceAddress: sourceAddressFor(params),
      createdAt: now,
      updatedAt: now,
    };

    if (!(await store.create(record))) {
      const raced = await store.get(idempotencyKey);
      if (!raced) {
        throw new Error(`Transfer ${idempotencyKey} disappeared from the store`);
      }
      return await resolveClaimedRecord(
        kernel,
        store,
        raced,
        params,
        owner,
        leaseMs,
      );
    }

    record.phase = "burning";
    record.updatedAt = Date.now();
    try {
      await store.put(record);
    } catch (err) {
      throw new TransferPersistenceError(
        "Failed to persist transfer start",
        record,
        undefined,
        { cause: err },
      );
    }

    let result: TransferResult;
    try {
      result = await kernel.transfer(params, {
        onProgress: progressWriter(store, record, owner, leaseMs),
      });
    } catch (err) {
      rethrowProgressError(err, record);
      if (err instanceof TransferError) {
        record.phase = "recoverable";
        record.burnTxHash = err.burnTxHash;
        if (err.attestationHash !== undefined) {
          record.attestationHash = err.attestationHash;
        }
        record.error = err.message;
      } else {
        record.phase = "failed";
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.updatedAt = Date.now();
      await persistFailure(store, record);
      throw err;
    }

    record.phase = result.status === "success" ? "minted" : "pending";
    record.result = result;
    record.burnTxHash = result.burnTxHash;
    record.attestationHash = result.attestationHash || undefined;
    record.mintTxHash = result.mintTxHash || undefined;
    record.updatedAt = Date.now();
    delete record.error;

    try {
      await store.put(record);
    } catch (err) {
      throw new TransferPersistenceError(
        "Failed to persist completed transfer state",
        record,
        result,
        { cause: err },
      );
    }

    return { record, result };
  } finally {
    await store.release(idempotencyKey, owner).catch(() => undefined);
  }
}
