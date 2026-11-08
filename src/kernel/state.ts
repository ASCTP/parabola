import { InvalidStateTransitionError } from "./errors.js";

export type TransferPhase =
  | "planned"
  | "burning"
  | "burned"
  | "attesting"
  | "attested"
  | "minting"
  | "minted"
  | "pending"
  | "recoverable"
  | "failed";

export type TransferEvent =
  | { type: "BURN_STARTED" }
  | { type: "BURN_CONFIRMED" }
  | { type: "BURN_FAILED" }
  | { type: "ATTESTATION_STARTED" }
  | { type: "ATTESTATION_READY" }
  | { type: "MINT_STARTED" }
  | { type: "MINT_CONFIRMED" }
  | { type: "DEFERRED" }
  | { type: "RECOVERY_REQUIRED" };

export type TransferEventType = TransferEvent["type"];

const TRANSITIONS: Record<
  TransferPhase,
  Partial<Record<TransferEventType, TransferPhase>>
> = {
  planned: {
    BURN_STARTED: "burning",
    BURN_FAILED: "failed",
  },
  burning: {
    BURN_CONFIRMED: "burned",
    BURN_FAILED: "failed",
  },
  burned: {
    ATTESTATION_STARTED: "attesting",
    RECOVERY_REQUIRED: "recoverable",
  },
  attesting: {
    ATTESTATION_READY: "attested",
    RECOVERY_REQUIRED: "recoverable",
  },
  attested: {
    MINT_STARTED: "minting",
    DEFERRED: "pending",
    RECOVERY_REQUIRED: "recoverable",
  },
  minting: {
    MINT_CONFIRMED: "minted",
    RECOVERY_REQUIRED: "recoverable",
  },
  minted: {},
  pending: {},
  recoverable: {},
  failed: {},
};

export function transition(
  phase: TransferPhase,
  event: TransferEvent,
): TransferPhase {
  const next = TRANSITIONS[phase][event.type];
  if (!next) {
    throw new InvalidStateTransitionError(phase, event.type);
  }
  return next;
}
