import type { TransferEventType, TransferPhase } from "./state.js";

export type KernelErrorCode = "INVALID_STATE_TRANSITION";

export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(message: string, code: KernelErrorCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidStateTransitionError extends KernelError {
  readonly from: TransferPhase;
  readonly event: TransferEventType;

  constructor(from: TransferPhase, event: TransferEventType) {
    super(
      `Invalid transfer transition: ${from} to ${event}`,
      "INVALID_STATE_TRANSITION",
    );
    this.from = from;
    this.event = event;
  }
}

export class TransferProgressError extends Error {
  constructor(cause: unknown) {
    super("Transfer progress handler failed", { cause });
    this.name = new.target.name;
  }
}
