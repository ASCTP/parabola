import type { TransferResult } from "../types.js";
import type { TransferRecord } from "./contracts.js";

export type TransferConflictReason =
  | "in_progress"
  | "recoverable"
  | "failed"
  | "mismatch";

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
    super(
      reason === "mismatch"
        ? `Transfer ${record.idempotencyKey} does not match the original request`
        : `Transfer ${record.idempotencyKey} is ${reason}`,
    );
    this.name = new.target.name;
    this.reason = reason;
    this.record = record;
  }
}

export class TransferNotFoundError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Transfer ${idempotencyKey} was not found`);
    this.name = new.target.name;
    this.idempotencyKey = idempotencyKey;
  }
}

export class TransferEvidenceError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, message: string) {
    super(`Transfer ${idempotencyKey} cannot be reconciled: ${message}`);
    this.name = new.target.name;
    this.idempotencyKey = idempotencyKey;
  }
}

export class TransferLeaseLostError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Lease for transfer ${idempotencyKey} was lost`);
    this.name = new.target.name;
    this.idempotencyKey = idempotencyKey;
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
