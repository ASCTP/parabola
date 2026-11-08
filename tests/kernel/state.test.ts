import { describe, expect, it } from "vitest";
import { InvalidStateTransitionError } from "../../src/kernel/errors.js";
import { transition, type TransferPhase } from "../../src/kernel/state.js";

describe("transfer state machine", () => {
  it("walks the successful transfer path", () => {
    let phase: TransferPhase = "planned";
    phase = transition(phase, { type: "BURN_STARTED" });
    expect(phase).toBe("burning");
    phase = transition(phase, { type: "BURN_CONFIRMED" });
    expect(phase).toBe("burned");
    phase = transition(phase, { type: "ATTESTATION_STARTED" });
    expect(phase).toBe("attesting");
    phase = transition(phase, { type: "ATTESTATION_READY" });
    expect(phase).toBe("attested");
    phase = transition(phase, { type: "MINT_STARTED" });
    expect(phase).toBe("minting");
    phase = transition(phase, { type: "MINT_CONFIRMED" });
    expect(phase).toBe("minted");
  });

  it("defers an attested transfer when there is no destination signer", () => {
    const phase = transition("attested", { type: "DEFERRED" });
    expect(phase).toBe("pending");
  });

  it("marks a post-burn failure recoverable", () => {
    expect(transition("attesting", { type: "RECOVERY_REQUIRED" })).toBe(
      "recoverable",
    );
    expect(transition("attested", { type: "RECOVERY_REQUIRED" })).toBe(
      "recoverable",
    );
    expect(transition("minting", { type: "RECOVERY_REQUIRED" })).toBe(
      "recoverable",
    );
  });

  it("marks a pre-burn failure failed", () => {
    expect(transition("planned", { type: "BURN_FAILED" })).toBe("failed");
    expect(transition("burning", { type: "BURN_FAILED" })).toBe("failed");
  });

  it("rejects an invalid transition with the phase and event", () => {
    let caught: unknown;
    try {
      transition("planned", { type: "MINT_STARTED" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidStateTransitionError);
    expect(caught).toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      from: "planned",
      event: "MINT_STARTED",
    });
  });

  it("treats terminal phases as terminal", () => {
    expect(() => transition("minted", { type: "MINT_CONFIRMED" })).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => transition("failed", { type: "BURN_STARTED" })).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => transition("recoverable", { type: "MINT_STARTED" })).toThrow(
      InvalidStateTransitionError,
    );
  });
});
