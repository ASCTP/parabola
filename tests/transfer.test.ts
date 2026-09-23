import { describe, it, expect, vi, beforeEach } from "vitest";

const approveUsdcOnArc = vi.fn();
const burnUsdcOnArc = vi.fn();
const burnUsdcOnArcWithStellarForward = vi.fn();
const receiveMessageOnArc = vi.fn();
const approveUsdcOnStellar = vi.fn();
const burnUsdcOnStellar = vi.fn();
const mintAndForwardOnStellar = vi.fn();
const checkStellarRecipientReady = vi.fn();
const fetchFastTransferFeeBps = vi.fn();
const pollForAttestation = vi.fn();

vi.mock("../src/chains/arc.js", () => ({
  approveUsdcOnArc: (...args: unknown[]) => approveUsdcOnArc(...args),
  burnUsdcOnArc: (...args: unknown[]) => burnUsdcOnArc(...args),
  burnUsdcOnArcWithStellarForward: (...args: unknown[]) => burnUsdcOnArcWithStellarForward(...args),
  receiveMessageOnArc: (...args: unknown[]) => receiveMessageOnArc(...args),
}));

vi.mock("../src/chains/stellar.js", () => ({
  approveUsdcOnStellar: (...args: unknown[]) => approveUsdcOnStellar(...args),
  burnUsdcOnStellar: (...args: unknown[]) => burnUsdcOnStellar(...args),
  mintAndForwardOnStellar: (...args: unknown[]) => mintAndForwardOnStellar(...args),
  checkStellarRecipientReady: (...args: unknown[]) => checkStellarRecipientReady(...args),
}));

vi.mock("../src/iris/poll.js", () => ({
  fetchFastTransferFeeBps: (...args: unknown[]) => fetchFastTransferFeeBps(...args),
  pollForAttestation: (...args: unknown[]) => pollForAttestation(...args),
}));

const { transfer, completeMint } = await import("../src/transfer.js");
const { TransferError, SubmissionTimeoutError } = await import("../src/errors.js");

const arcSigner = { walletClient: {} } as any;
const stellarSigner = { publicKey: "GABCD" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  approveUsdcOnArc.mockResolvedValue("0xapprovehash");
  burnUsdcOnArc.mockResolvedValue("0xburnhash");
  burnUsdcOnArcWithStellarForward.mockResolvedValue("0xburnhookhash");
  approveUsdcOnStellar.mockResolvedValue("stellarapprovehash");
  burnUsdcOnStellar.mockResolvedValue("stellarburnhash");
  checkStellarRecipientReady.mockResolvedValue({ exists: true, hasTrustline: true, ready: true });
  pollForAttestation.mockResolvedValue({
    message: "0xmessage",
    attestation: "0xattestation",
  });
  receiveMessageOnArc.mockResolvedValue("0xminthash");
  mintAndForwardOnStellar.mockResolvedValue("stellarminthash");
});

describe("transfer (Arc -> Stellar)", () => {
  it("routes the burn through depositForBurnWithHook and mints via CctpForwarder", async () => {
    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
      options: { destinationSigner: stellarSigner },
    });

    expect(burnUsdcOnArcWithStellarForward).toHaveBeenCalledTimes(1);
    expect(burnUsdcOnArc).not.toHaveBeenCalled();
    expect(mintAndForwardOnStellar).toHaveBeenCalledTimes(1);
    expect(receiveMessageOnArc).not.toHaveBeenCalled();

    expect(result.status).toBe("success");
    expect(result.burnTxHash).toBe("0xburnhookhash");
    expect(result.mintTxHash).toBe("stellarminthash");
    expect(result.attestationHash).toBe("0xattestation");
  });

  it("returns pending status with no mint tx hash when no destinationSigner is given", async () => {
    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
    });

    expect(result.status).toBe("pending");
    expect(result.mintTxHash).toBe("");
    expect(mintAndForwardOnStellar).not.toHaveBeenCalled();
  });

  it("converts a burn-step SubmissionTimeoutError into a recoverable TransferError", async () => {
    burnUsdcOnArcWithStellarForward.mockRejectedValueOnce(
      new SubmissionTimeoutError("Timed out waiting for receipt", "0xburnhookhash"),
    );

    await expect(
      transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        speed: "standard",
        signer: arcSigner,
        options: { destinationSigner: stellarSigner },
      }),
    ).rejects.toMatchObject({
      burnTxHash: "0xburnhookhash",
    });
    expect(pollForAttestation).not.toHaveBeenCalled();
  });

  it("rethrows a TransferError carrying burnTxHash when the mint step fails", async () => {
    mintAndForwardOnStellar.mockRejectedValueOnce(new Error("Account not found: GABCD"));

    await expect(
      transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        speed: "standard",
        signer: arcSigner,
        options: { destinationSigner: stellarSigner },
      }),
    ).rejects.toMatchObject({
      burnTxHash: "0xburnhookhash",
      attestationHash: "0xattestation",
      message: "Account not found: GABCD",
    });
  });

  it("rethrows a TransferError carrying burnTxHash when attestation polling fails", async () => {
    pollForAttestation.mockRejectedValueOnce(new Error("Timed out after 300000ms"));

    let caught: unknown;
    try {
      await transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        speed: "standard",
        signer: arcSigner,
        options: { destinationSigner: stellarSigner },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TransferError);
    expect((caught as InstanceType<typeof TransferError>).burnTxHash).toBe("0xburnhookhash");
    expect((caught as InstanceType<typeof TransferError>).attestationHash).toBeUndefined();
  });

  it("checks Stellar recipient readiness before approving or burning anything on Arc", async () => {
    await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
      options: { destinationSigner: stellarSigner },
    });

    expect(checkStellarRecipientReady).toHaveBeenCalledWith(
      "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "mainnet",
      undefined,
    );
  });

  it("refuses to burn toward a Stellar recipient that doesn't exist yet", async () => {
    checkStellarRecipientReady.mockResolvedValue({ exists: false, hasTrustline: false, ready: false });

    await expect(
      transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        speed: "standard",
        signer: arcSigner,
        options: { destinationSigner: stellarSigner },
      }),
    ).rejects.toThrow(/does not exist yet/);

    expect(approveUsdcOnArc).not.toHaveBeenCalled();
    expect(burnUsdcOnArcWithStellarForward).not.toHaveBeenCalled();
  });

  it("refuses to burn toward a Stellar recipient with no USDC trustline", async () => {
    checkStellarRecipientReady.mockResolvedValue({ exists: true, hasTrustline: false, ready: false });

    await expect(
      transfer({
        from: "arc",
        to: "stellar",
        amount: "10",
        recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        speed: "standard",
        signer: arcSigner,
        options: { destinationSigner: stellarSigner },
      }),
    ).rejects.toThrow(/no USDC trustline/);

    expect(approveUsdcOnArc).not.toHaveBeenCalled();
    expect(burnUsdcOnArcWithStellarForward).not.toHaveBeenCalled();
  });

  it("can be finished later via completeMint using the returned burnTxHash", async () => {
    const pending = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
    });

    const completed = await completeMint({
      from: "arc",
      to: "stellar",
      burnTxHash: pending.burnTxHash,
      signer: stellarSigner,
    });

    expect(mintAndForwardOnStellar).toHaveBeenCalledTimes(1);
    expect(completed.mintTxHash).toBe("stellarminthash");
    expect(completed.attestationHash).toBe("0xattestation");
  });
});

describe("transfer (Stellar -> Arc)", () => {
  it("burns via TokenMessengerMinter and mints via receiveMessage", async () => {
    const result = await transfer({
      from: "stellar",
      to: "arc",
      amount: "25",
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      speed: "standard",
      signer: stellarSigner,
      options: { destinationSigner: arcSigner },
    });

    expect(burnUsdcOnStellar).toHaveBeenCalledTimes(1);
    expect(receiveMessageOnArc).toHaveBeenCalledTimes(1);
    expect(result.burnTxHash).toBe("stellarburnhash");
    expect(result.mintTxHash).toBe("0xminthash");
  });
});

describe("transfer network selection", () => {
  it("defaults to mainnet: burns with network mainnet and polls the production Iris API", async () => {
    await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
      options: { destinationSigner: stellarSigner },
    });

    expect(burnUsdcOnArcWithStellarForward.mock.calls[0]?.[0].network).toBe("mainnet");
    expect(mintAndForwardOnStellar.mock.calls[0]?.[0].network).toBe("mainnet");
    expect(pollForAttestation.mock.calls[0]?.[0].useSandbox).toBe(false);
  });

  it("routes explicit testnet to the testnet config and the sandbox Iris API", async () => {
    await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
      network: "testnet",
      options: { destinationSigner: stellarSigner },
    });

    expect(checkStellarRecipientReady).toHaveBeenCalledWith(
      "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "testnet",
      undefined,
    );
    expect(burnUsdcOnArcWithStellarForward.mock.calls[0]?.[0].network).toBe("testnet");
    expect(pollForAttestation.mock.calls[0]?.[0].useSandbox).toBe(true);
  });

  it("threads a Stellar RPC override into the recipient check and mint call", async () => {
    await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "standard",
      signer: arcSigner,
      options: { destinationSigner: stellarSigner, stellarRpcUrl: "https://my-soroban.example/rpc" },
    });

    expect(checkStellarRecipientReady).toHaveBeenCalledWith(
      "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "mainnet",
      "https://my-soroban.example/rpc",
    );
    expect(mintAndForwardOnStellar.mock.calls[0]?.[0].rpcUrl).toBe("https://my-soroban.example/rpc");
  });

  it("completeMint defaults to mainnet and polls the production Iris API", async () => {
    await completeMint({
      from: "arc",
      to: "stellar",
      burnTxHash: "0xburnhookhash",
      signer: stellarSigner,
    });

    expect(pollForAttestation.mock.calls[0]?.[0].useSandbox).toBe(false);
    expect(mintAndForwardOnStellar.mock.calls[0]?.[0].network).toBe("mainnet");
  });
});

describe("transfer fast/standard fee handling", () => {
  it("falls back to standard when the quoted fast fee exceeds maxFee", async () => {
    fetchFastTransferFeeBps.mockResolvedValue(100); // 1% - exceeds maxFee below

    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "fast",
      signer: arcSigner,
      options: { maxFee: "0.01", destinationSigner: stellarSigner },
    });

    expect(result.transferMode).toBe("standard");
    expect(result.fee).toBe("0");
  });

  it("uses fast mode and reports the quoted fee when within maxFee", async () => {
    fetchFastTransferFeeBps.mockResolvedValue(1); // 0.01%

    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "1000",
      recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      speed: "fast",
      signer: arcSigner,
      options: { maxFee: "1", destinationSigner: stellarSigner },
    });

    expect(result.transferMode).toBe("fast");
    expect(result.fee).toBe("0.1");
  });
});
