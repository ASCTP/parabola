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
  TransferPersistenceError,
} from "./errors.js";

export interface ExecuteTransferOptions {
  idempotencyKey: string;
}

export interface ExecuteTransferOutcome {
  record: TransferRecord;
  result: TransferResult;
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
    record.recipient !== params.recipient
  ) {
    throw new TransferConflictError("mismatch", record);
  }
}

function resultFromRecord(record: TransferRecord): TransferResult | undefined {
  if (record.result) {
    return record.result;
  }
  if (
    record.burnTxHash === undefined ||
    (record.phase !== "minted" && record.phase !== "pending")
  ) {
    return undefined;
  }
  return {
    status: record.phase === "minted" ? "success" : "pending",
    transferMode: record.transferMode ?? "standard",
    burnTxHash: record.burnTxHash,
    attestationHash: record.attestationHash ?? "",
    mintTxHash: record.mintTxHash ?? "",
    fee: record.fee ?? "0",
    durationMs: record.updatedAt - record.createdAt,
  };
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
): NonNullable<TransferRunOptions["onProgress"]> {
  return async (progress) => {
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
    if (err.cause instanceof TransferPersistenceError) {
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
      onProgress: progressWriter(store, record),
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

  const existing = await store.get(idempotencyKey);
  if (existing) {
    assertSameTransfer(existing, params);
    const replayed = resultFromRecord(existing);
    if (replayed) {
      return replayTransfer(store, existing, replayed);
    }
    if (isResumable(existing)) {
      return resumeTransfer(kernel, store, existing, params);
    }
    if (existing.phase === "recoverable") {
      throw new TransferConflictError("recoverable", existing);
    }
    if (existing.phase === "failed") {
      throw new TransferConflictError("failed", existing);
    }
    throw new TransferConflictError("in_progress", existing);
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
    createdAt: now,
    updatedAt: now,
  };

  if (!(await store.create(record))) {
    const raced = await store.get(idempotencyKey);
    if (!raced) {
      throw new Error(`Transfer ${idempotencyKey} disappeared from the store`);
    }
    assertSameTransfer(raced, params);
    const replayed = resultFromRecord(raced);
    if (replayed) {
      return replayTransfer(store, raced, replayed);
    }
    if (isResumable(raced)) {
      return resumeTransfer(kernel, store, raced, params);
    }
    if (raced.phase === "recoverable") {
      throw new TransferConflictError("recoverable", raced);
    }
    if (raced.phase === "failed") {
      throw new TransferConflictError("failed", raced);
    }
    throw new TransferConflictError("in_progress", raced);
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
      onProgress: progressWriter(store, record),
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
}
