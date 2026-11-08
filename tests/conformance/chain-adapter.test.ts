import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../../src/kernel/contracts.js";

const ARC_RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const STELLAR_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ARC_SIGNER = { walletClient: {} } as any;
const STELLAR_SIGNER = { publicKey: "GABCD" } as any;

async function assertConforms(adapter: ChainAdapter): Promise<void> {
  const isArc = adapter.chain === "arc";
  const burn = await adapter.burn({
    from: adapter.chain,
    to: isArc ? "stellar" : "arc",
    network: "testnet",
    amountRaw: 1_000_000n,
    recipient: isArc ? ARC_RECIPIENT : STELLAR_RECIPIENT,
    maxFeeRaw: 0n,
    minFinalityThreshold: 2000,
    signer: isArc ? ARC_SIGNER : STELLAR_SIGNER,
  });
  if (!burn.transactionHash) {
    throw new Error("burn returned an empty transaction hash");
  }

  const mint = await adapter.mint({
    from: isArc ? "stellar" : "arc",
    to: adapter.chain,
    network: "testnet",
    message: "0xmessage",
    attestation: "0xattestation",
    signer: isArc ? ARC_SIGNER : STELLAR_SIGNER,
  });
  if (!mint.transactionHash) {
    throw new Error("mint returned an empty transaction hash");
  }

  await adapter.assertCanReceive?.({
    recipient: isArc ? ARC_RECIPIENT : STELLAR_RECIPIENT,
    network: "testnet",
  });
}

function fakeAdapter(chain: "arc" | "stellar"): ChainAdapter {
  return {
    chain,
    async burn(request) {
      return { transactionHash: `burn-${request.from}-${request.to}` };
    },
    async mint(request) {
      return { transactionHash: `mint-${request.from}-${request.to}` };
    },
    async assertCanReceive() {},
  };
}

describe("chain adapter conformance", () => {
  it("passes for Arc and Stellar adapters that honour the contract", async () => {
    await expect(assertConforms(fakeAdapter("arc"))).resolves.toBeUndefined();
    await expect(assertConforms(fakeAdapter("stellar"))).resolves.toBeUndefined();
  });

  it("fails an adapter that returns an empty burn hash", async () => {
    const adapter = fakeAdapter("arc");
    adapter.burn = async () => ({ transactionHash: "" });

    await expect(assertConforms(adapter)).rejects.toThrow(
      /burn returned an empty transaction hash/,
    );
  });

  it("fails an adapter that returns an empty mint hash", async () => {
    const adapter = fakeAdapter("stellar");
    adapter.mint = async () => ({ transactionHash: "" });

    await expect(assertConforms(adapter)).rejects.toThrow(
      /mint returned an empty transaction hash/,
    );
  });
});
