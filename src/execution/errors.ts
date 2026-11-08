import type { TransferResult } from "../types.js";
import type { TransferRecord } from "./contracts.js";

export type TransferConflictReason = "in_progress" | "recoverable" | "failed";

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super("idempotencyKey must be a non-empty string");
    this.name = new.target.name;
  }
}

export class TransferConflictError extends Error {
  readonly reason: TransferConflictReason;
  readonly record: TransferRecord;

  constructor(reason: TransferConflictReason, record: TransferRecord) {
    super(`Transfer ${record.idempotencyKey} is ${reason}`);
    this.name = new.target.name;
    this.reason = reason;
    this.record = record;
  }
}

export class TransferPersistenceError extends Error {
  readonly record: TransferRecord;
  readonly result?: TransferResult;

  constructor(
    message: string,
    record: TransferRecord,
    result?: TransferResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.record = record;
    this.result = result;
  }
}
