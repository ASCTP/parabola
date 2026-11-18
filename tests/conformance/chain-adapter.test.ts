import { describe, expect, it } from "vitest";
import {
  ConformanceError,
  assertChainAdapterConforms,
  assertSettlementDependenciesConform,
  probeChainAdapter,
} from "../../src/conformance/index.js";
import type {
  ChainAdapter,
  SettlementDependencies,
} from "../../src/kernel/contracts.js";
import {
  ARC_SIGNER,
  STELLAR_SIGNER,
  fakeChainAdapter,
} from "../helpers/fake-chain-adapter.js";

const ARC_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const STELLAR_RECIPIENT =
  "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const MESSAGE = "0xmessage" as `0x${string}`;
const ATTESTATION = "0xattestation" as `0x${string}`;

function probeOptions(chain: "arc" | "stellar") {
  return {
    network: "testnet" as const,
    amountRaw: 1_000_000n,
    recipient: chain === "arc" ? STELLAR_RECIPIENT : ARC_RECIPIENT,
    signer: chain === "arc" ? ARC_SIGNER : STELLAR_SIGNER,
    message: MESSAGE,
    attestation: ATTESTATION,
  };
}

function dependencies(
  overrides: Partial<SettlementDependencies> = {},
): SettlementDependencies {
  return {
    chains: {
      arc: fakeChainAdapter("arc"),
      stellar: fakeChainAdapter("stellar"),
    },
    attestations: {
      async read() {
        return {
          attestation: null,
          message: null,
          status: "pending_confirmations",
        };
      },
      async poll() {
        return {
          attestation: null,
          message: null,
          status: "pending_confirmations",
        };
      },
    },
    fees: {
      async fastTransferFeeBps() {
        return 0;
      },
    },
    ...overrides,
  };
}

describe("chain adapter conformance", () => {
  it("accepts adapters that expose the required surface", () => {
    expect(() => {
      assertChainAdapterConforms(fakeChainAdapter("arc"));
      assertChainAdapterConforms(fakeChainAdapter("stellar"));
    }).not.toThrow();
  });

  it("rejects an adapter with an unknown chain", () => {
    const adapter = {
      ...fakeChainAdapter("arc"),
      chain: "solana",
    } as unknown as ChainAdapter;

    expect(() => assertChainAdapterConforms(adapter)).toThrow(
      /expected "arc" or "stellar"/,
    );
  });

  it("rejects an adapter without a burn function", () => {
    const adapter = {
      ...fakeChainAdapter("arc"),
      burn: undefined,
    } as unknown as ChainAdapter;

    expect(() => assertChainAdapterConforms(adapter)).toThrow(
      /burn must be a function/,
    );
  });

  it("rejects an adapter without a mint function", () => {
    const adapter = {
      ...fakeChainAdapter("arc"),
      mint: undefined,
    } as unknown as ChainAdapter;

    expect(() => assertChainAdapterConforms(adapter)).toThrow(
      /mint must be a function/,
    );
  });

  it("probes burn, mint, and the recipient check", async () => {
    const adapter = fakeChainAdapter("arc");

    const result = await probeChainAdapter(adapter, probeOptions("arc"));

    expect(result).toEqual({
      burn: { transactionHash: "burn-arc-stellar" },
      mint: { transactionHash: "mint-stellar-arc" },
      recipientCheck: "passed",
    });
  });

  it("skips the recipient check when requested", async () => {
    const result = await probeChainAdapter(fakeChainAdapter("stellar"), {
      ...probeOptions("stellar"),
      checkRecipient: false,
    });

    expect(result.recipientCheck).toBe("skipped");
  });

  it("skips the recipient check when the adapter does not implement it", async () => {
    const adapter = {
      ...fakeChainAdapter("arc"),
      assertCanReceive: undefined,
    };

    const result = await probeChainAdapter(adapter, probeOptions("arc"));

    expect(result.recipientCheck).toBe("skipped");
  });

  it("fails a probe that returns an empty burn hash", async () => {
    const adapter = fakeChainAdapter("arc");
    adapter.burn = async () => ({ transactionHash: "" });

    await expect(
      probeChainAdapter(adapter, probeOptions("arc")),
    ).rejects.toThrow(/burn returned an empty transaction hash/);
  });

  it("fails a probe that returns an empty mint hash", async () => {
    const adapter = fakeChainAdapter("stellar");
    adapter.mint = async () => ({ transactionHash: "" });

    await expect(
      probeChainAdapter(adapter, probeOptions("stellar")),
    ).rejects.toThrow(/mint returned an empty transaction hash/);
  });

  it("exposes the failed check on the error", async () => {
    const adapter = fakeChainAdapter("arc");
    adapter.mint = async () => ({ transactionHash: "" });

    await expect(
      probeChainAdapter(adapter, probeOptions("arc")),
    ).rejects.toMatchObject({
      name: "ConformanceError",
      check: "mint",
    });
  });
});

describe("settlement dependency conformance", () => {
  it("accepts a complete dependency set", () => {
    expect(() =>
      assertSettlementDependenciesConform(dependencies()),
    ).not.toThrow();
  });

  it("rejects a missing chain adapter", () => {
    const value = dependencies();
    value.chains = {
      arc: fakeChainAdapter("arc"),
    } as Record<"arc" | "stellar", ChainAdapter>;

    expect(() => assertSettlementDependenciesConform(value)).toThrow(
      /missing stellar adapter/,
    );
  });

  it("rejects an adapter in the wrong chain slot", () => {
    const value = dependencies();
    value.chains = {
      arc: fakeChainAdapter("stellar"),
      stellar: fakeChainAdapter("stellar"),
    };

    expect(() => assertSettlementDependenciesConform(value)).toThrow(
      /arc slot contains a stellar adapter/,
    );
  });

  it("rejects missing attestation methods", () => {
    const value = dependencies();
    value.attestations = {
      read: async () => ({
        attestation: null,
        message: null,
        status: "pending_confirmations",
      }),
    } as unknown as SettlementDependencies["attestations"];

    expect(() => assertSettlementDependenciesConform(value)).toThrow(
      /attestations: poll must be a function/,
    );
  });

  it("rejects a missing fee adapter", () => {
    const value = dependencies();
    value.fees = {} as SettlementDependencies["fees"];

    expect(() => assertSettlementDependenciesConform(value)).toThrow(
      /fees: fastTransferFeeBps must be a function/,
    );
  });

  it("throws a typed conformance error", () => {
    expect(() =>
      assertSettlementDependenciesConform(
        dependencies({ fees: {} as SettlementDependencies["fees"] }),
      ),
    ).toThrow(ConformanceError);
  });
});
