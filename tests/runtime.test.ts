import { describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../src/execution/contracts.js";
import { MemoryTransferStore } from "../src/execution/memory-store.js";
import type { SettlementKernel } from "../src/kernel/contracts.js";
import { createSettlementRuntime } from "../src/runtime.js";
import type {
  ResolvedBurn,
  TransferParams,
  TransferResult,
} from "../src/types.js";

const RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

const PARAMS = {
  from: "arc",
  to: "stellar",
  amount: "10",
  recipient: RECIPIENT,
  speed: "standard",
  signer: {
    walletClient: {
      account: { address: "0x1111111111111111111111111111111111111111" },
    },
  },
} as unknown as TransferParams;

function result(overrides: Partial<TransferResult> = {}): TransferResult {
  return {
    status: "success",
    transferMode: "standard",
    burnTxHash: "burn-1",
    attestationHash: "0xattestation",
    mintTxHash: "mint-1",
    fee: "0.01",
    durationMs: 1200,
    ...overrides,
  };
}

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-2",
    phase: "planned",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function kernel(
  transfer: SettlementKernel["transfer"] = async () => result(),
  resolveBurn: SettlementKernel["resolveBurn"] = async () =>
    ({}) as ResolvedBurn,
): SettlementKernel {
  return {
    transfer,
    async completeMint() {
      throw new Error("completeMint is not part of this test");
    },
    resolveBurn,
  };
}

describe("settlement runtime", () => {
  it("executes a transfer through a durable store and kernel", async () => {
    const store = new MemoryTransferStore();
    const runtime = createSettlementRuntime(store, { kernel: kernel() });

    const outcome = await runtime.execute(PARAMS, {
      idempotencyKey: "order-1",
    });

    expect(outcome.result).toEqual(result());
    expect(await store.get("order-1")).toMatchObject({
      phase: "minted",
      burnTxHash: "burn-1",
      mintTxHash: "mint-1",
    });
  });

  it("reconciles evidence through the same store", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const runtime = createSettlementRuntime(store, { kernel: kernel() });

    const outcome = await runtime.reconcile({
      idempotencyKey: "order-2",
      evidence: { burnTxHash: "burn-2" },
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.record.phase).toBe("burned");
    expect(outcome.record.burnTxHash).toBe("burn-2");
  });

  it("delegates read-only burn resolution to the kernel", async () => {
    const store = new MemoryTransferStore();
    const resolved = { burnTxHash: "burn-1" } as unknown as ResolvedBurn;
    const resolveBurn = vi.fn().mockResolvedValue(resolved);
    const runtime = createSettlementRuntime(store, {
      kernel: kernel(undefined, resolveBurn),
    });

    await expect(
      runtime.resolveBurn({
        from: "arc",
        burnTxHash: "burn-1",
        network: "mainnet",
      }),
    ).resolves.toBe(resolved);
    expect(resolveBurn).toHaveBeenCalledOnce();
  });

  it("indexes an empty store without touching a chain", async () => {
    const store = new MemoryTransferStore();
    const runtime = createSettlementRuntime(store, { kernel: kernel() });

    const summary = await runtime.indexArcBurns({
      network: "mainnet",
      fromBlock: 1n,
      toBlock: 2n,
    });

    expect(summary).toEqual({
      reconciled: [],
      unmatched: [],
      ambiguous: [],
      skipped: [],
      busy: [],
    });
  });

  it("builds a runtime with the default kernel", () => {
    const runtime = createSettlementRuntime(new MemoryTransferStore());

    expect(runtime.execute).toBeTypeOf("function");
    expect(runtime.syncStellarBurns).toBeTypeOf("function");
  });
});
