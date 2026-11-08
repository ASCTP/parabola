import { TransferError } from "../errors.js";
import type { SettlementKernel } from "../kernel/contracts.js";
import type { TransferParams, TransferResult } from "../types.js";
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
    const existing = await store.get(idempotencyKey);
    if (!existing) {
      throw new Error(`Transfer ${idempotencyKey} disappeared from the store`);
    }
    if (
      existing.result &&
      (existing.phase === "minted" || existing.phase === "pending")
    ) {
      return { record: existing, result: existing.result };
    }
    if (existing.phase === "recoverable") {
      throw new TransferConflictError("recoverable", existing);
    }
    if (existing.phase === "failed") {
      throw new TransferConflictError("failed", existing);
    }
    throw new TransferConflictError("in_progress", existing);
  }

  record.phase = "burning";
  record.updatedAt = Date.now();
  await store.put(record);

  let result: TransferResult;
  try {
    result = await kernel.transfer(params);
  } catch (err) {
    if (err instanceof TransferError) {
      record.phase = "recoverable";
      record.burnTxHash = err.burnTxHash;
      record.attestationHash = err.attestationHash;
      record.error = err.message;
    } else {
      record.phase = "failed";
      record.error = err instanceof Error ? err.message : String(err);
    }
    record.updatedAt = Date.now();
    try {
      await store.put(record);
    } catch (storeErr) {
      throw new TransferPersistenceError(
        "Failed to persist transfer failure state",
        record,
        undefined,
        { cause: storeErr },
      );
    }
    throw err;
  }

  record.phase = result.status === "success" ? "minted" : "pending";
  record.result = result;
  record.burnTxHash = result.burnTxHash;
  record.attestationHash = result.attestationHash || undefined;
  record.mintTxHash = result.mintTxHash || undefined;
  record.updatedAt = Date.now();

  try {
    await store.put(record);
  } catch (storeErr) {
    throw new TransferPersistenceError(
      "Failed to persist completed transfer state",
      record,
      result,
      { cause: storeErr },
    );
  }

  return { record, result };
}
