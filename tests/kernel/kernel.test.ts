import { describe, expect, it } from "vitest";
import {
  AttestationNotReadyError,
  SubmissionTimeoutError,
  TransferError,
} from "../../src/errors.js";
import type {
  AttestationAdapter,
  ChainAdapter,
  FeeAdapter,
  SettlementDependencies,
  TransferProgress,
} from "../../src/kernel/contracts.js";
import { TransferProgressError } from "../../src/kernel/errors.js";
import { createSettlementKernel } from "../../src/kernel/kernel.js";
import { buildBurnMessage } from "../helpers/cctp-message.js";

const ARC_SIGNER = { walletClient: {} } as any;
const STELLAR_SIGNER = { publicKey: "GABCD" } as any;
const FORWARD_RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const ARC_RECIPIENT =
  "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

function harness(): { deps: SettlementDependencies; calls: string[] } {
  const calls: string[] = [];

  const arc: ChainAdapter = {
    chain: "arc",
    async burn() {
      calls.push("arc.burn");
      return { transactionHash: "arc-burn" };
    },
    async mint() {
      calls.push("arc.mint");
      return { transactionHash: "arc-mint" };
    },
  };

  const stellar: ChainAdapter = {
    chain: "stellar",
    async burn() {
      calls.push("stellar.burn");
      return { transactionHash: "stellar-burn" };
    },
    async mint() {
      calls.push("stellar.mint");
      return { transactionHash: "stellar-mint" };
    },
    async assertCanReceive() {
      calls.push("stellar.check");
    },
  };

  const attestations: AttestationAdapter = {
    async read() {
      calls.push("attestation.read");
      return {
        message: buildBurnMessage({ forwardRecipient: FORWARD_RECIPIENT }),
        attestation: "0xattestation",
        status: "complete",
      };
    },
    async poll() {
      calls.push("attestation.poll");
      return {
        message: buildBurnMessage({ forwardRecipient: FORWARD_RECIPIENT }),
        attestation: "0xattestation",
        status: "complete",
      };
    },
  };

  const fees: FeeAdapter = {
    async fastTransferFeeBps() {
      return 0;
    },
  };

  return {
    deps: {
      chains: { arc, stellar },
      attestations,
      fees,
    },
    calls,
  };
}

describe("settlement kernel", () => {
  it("orchestrates burn, attestation, and mint through providers", async () => {
    const { deps, calls } = harness();
    const kernel = createSettlementKernel(deps);

    const result = await kernel.transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: ARC_RECIPIENT,
      speed: "standard",
      signer: ARC_SIGNER,
      options: { destinationSigner: STELLAR_SIGNER },
    });

    expect(calls).toEqual([
      "stellar.check",
      "arc.burn",
      "attestation.poll",
      "stellar.mint",
    ]);
    expect(result).toMatchObject({
      status: "success",
      burnTxHash: "arc-burn",
      mintTxHash: "stellar-mint",
      attestationHash: "0xattestation",
    });
  });

  it("returns pending when no destination signer is provided", async () => {
    const { deps, calls } = harness();
    const kernel = createSettlementKernel(deps);

    const result = await kernel.transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: ARC_RECIPIENT,
      speed: "standard",
      signer: ARC_SIGNER,
    });

    expect(calls).toEqual(["stellar.check", "arc.burn", "attestation.poll"]);
    expect(result).toMatchObject({
      status: "pending",
      burnTxHash: "arc-burn",
      mintTxHash: "",
    });
  });

  it("wraps a post-burn failure in a TransferError with the recoverable code", async () => {
    const { deps, calls } = harness();
    deps.attestations.poll = async () => {
      throw new AttestationNotReadyError("slow", "arc-burn");
    };
    const kernel = createSettlementKernel(deps);

    const err = await kernel
      .transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: ARC_RECIPIENT,
        speed: "standard",
        signer: ARC_SIGNER,
        options: { destinationSigner: STELLAR_SIGNER },
      })
      .catch((error) => error);

    expect(err).toBeInstanceOf(TransferError);
    expect(err).toMatchObject({
      code: "ATTESTATION_NOT_READY",
      burnTxHash: "arc-burn",
    });
    expect(calls).toEqual(["stellar.check", "arc.burn"]);
  });

  it("turns a burn submission timeout into a TransferError before polling", async () => {
    const { deps, calls } = harness();
    deps.chains.arc.burn = async () => {
      throw new SubmissionTimeoutError("timeout", "arc-burn");
    };
    const kernel = createSettlementKernel(deps);

    const err = await kernel
      .transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: ARC_RECIPIENT,
        speed: "standard",
        signer: ARC_SIGNER,
        options: { destinationSigner: STELLAR_SIGNER },
      })
      .catch((error) => error);

    expect(err).toBeInstanceOf(TransferError);
    expect(err).toMatchObject({ burnTxHash: "arc-burn" });
    expect(calls).toEqual(["stellar.check"]);
  });

  it("completes a Stellar mint without repeating the burn", async () => {
    const { deps, calls } = harness();
    const kernel = createSettlementKernel(deps);

    const result = await kernel.completeMint({
      from: "arc",
      to: "stellar",
      burnTxHash: "arc-burn",
      signer: STELLAR_SIGNER,
    });

    expect(calls).toEqual([
      "attestation.poll",
      "stellar.check",
      "stellar.mint",
    ]);
    expect(result).toEqual({
      mintTxHash: "stellar-mint",
      attestationHash: "0xattestation",
    });
  });

  it("resolves a burn with a single attestation read", async () => {
    const { deps, calls } = harness();
    const kernel = createSettlementKernel(deps);

    const result = await kernel.resolveBurn({
      from: "arc",
      burnTxHash: "arc-burn",
    });

    expect(calls).toEqual(["attestation.read"]);
    expect(result.sourceDomain).toBe(26);
    expect(result.destinationDomain).toBe(27);
    expect(result.forwardRecipient).toBe(FORWARD_RECIPIENT);
  });

  it("reports durable progress for a successful transfer", async () => {
    const { deps } = harness();
    const kernel = createSettlementKernel(deps);
    const progress: TransferProgress[] = [];

    await kernel.transfer(
      {
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: ARC_RECIPIENT,
        speed: "standard",
        signer: ARC_SIGNER,
        options: { destinationSigner: STELLAR_SIGNER },
      },
      {
        onProgress(event) {
          progress.push(event);
        },
      },
    );

    expect(progress.map((event) => event.phase)).toEqual([
      "burning",
      "burned",
      "attested",
      "minting",
      "minted",
    ]);
    expect(progress[0]).toMatchObject({
      phase: "burning",
      transferMode: "standard",
      fee: "0",
    });
    expect(progress[1]).toMatchObject({
      phase: "burned",
      burnTxHash: "arc-burn",
    });
    expect(progress[2]).toMatchObject({
      phase: "attested",
      attestationHash: "0xattestation",
    });
    expect(progress[4]).toMatchObject({
      phase: "minted",
      mintTxHash: "stellar-mint",
    });
  });

  it("reports pending progress when no destination signer is provided", async () => {
    const { deps } = harness();
    const kernel = createSettlementKernel(deps);
    const progress: TransferProgress[] = [];

    await kernel.transfer(
      {
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: ARC_RECIPIENT,
        speed: "standard",
        signer: ARC_SIGNER,
      },
      {
        onProgress(event) {
          progress.push(event);
        },
      },
    );

    expect(progress.map((event) => event.phase)).toEqual([
      "burning",
      "burned",
      "attested",
      "pending",
    ]);
  });

  it("aborts after a burn when progress cannot be persisted", async () => {
    const { deps, calls } = harness();
    const kernel = createSettlementKernel(deps);
    const failure = new Error("disk full");

    const err = await kernel
      .transfer(
        {
          from: "arc",
          to: "stellar",
          amount: "10",
          recipient: ARC_RECIPIENT,
          speed: "standard",
          signer: ARC_SIGNER,
          options: { destinationSigner: STELLAR_SIGNER },
        },
        {
          onProgress(event) {
            if (event.phase === "burned") {
              throw failure;
            }
          },
        },
      )
      .catch((error) => error);

    expect(err).toBeInstanceOf(TransferProgressError);
    expect(err).toMatchObject({ cause: failure });
    expect(calls).toEqual(["stellar.check", "arc.burn"]);
  });

  it("reports durable progress when completing a mint", async () => {
    const { deps } = harness();
    const kernel = createSettlementKernel(deps);
    const progress: TransferProgress[] = [];

    await kernel.completeMint(
      {
        from: "arc",
        to: "stellar",
        burnTxHash: "arc-burn",
        signer: STELLAR_SIGNER,
      },
      {
        onProgress(event) {
          progress.push(event);
        },
      },
    );

    expect(progress.map((event) => event.phase)).toEqual([
      "attesting",
      "attested",
      "minting",
      "minted",
    ]);
  });
});
