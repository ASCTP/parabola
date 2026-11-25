import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementKernel } from "../src/kernel/contracts.js";

const indexArcBurns = vi.fn();
const indexArcMints = vi.fn();
const indexStellarBurns = vi.fn();
const indexStellarMints = vi.fn();
const syncArcBurns = vi.fn();
const syncArcMints = vi.fn();
const syncStellarBurns = vi.fn();
const syncStellarMints = vi.fn();
const reconcileTransfer = vi.fn();
const executeTransfer = vi.fn();

vi.mock("../src/indexer/arc-burns.js", () => ({ indexArcBurns }));
vi.mock("../src/indexer/arc-mints.js", () => ({ indexArcMints }));
vi.mock("../src/indexer/stellar-burns.js", () => ({ indexStellarBurns }));
vi.mock("../src/indexer/stellar-mints.js", () => ({ indexStellarMints }));
vi.mock("../src/indexer/arc-sync.js", () => ({ syncArcBurns, syncArcMints }));
vi.mock("../src/indexer/stellar-sync.js", () => ({
  syncStellarBurns,
  syncStellarMints,
}));
vi.mock("../src/execution/reconciler.js", () => ({ reconcileTransfer }));
vi.mock("../src/execution/executor.js", () => ({ executeTransfer }));

const { MemoryTransferStore } = await import(
  "../src/execution/memory-store.js"
);
const { createSettlementRuntime } = await import("../src/runtime.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settlement runtime delegation", () => {
  const store = new MemoryTransferStore();
  const kernel = {
    transfer: vi.fn(),
    completeMint: vi.fn(),
    resolveBurn: vi.fn().mockResolvedValue({ resolved: true }),
  } as unknown as SettlementKernel;

  it("passes each indexing call to its indexer with the store", async () => {
    const runtime = createSettlementRuntime(store, { kernel });
    const arc = {
      network: "testnet" as const,
      fromBlock: 1n,
      toBlock: 2n,
    };
    const stellar = {
      network: "testnet" as const,
      startLedger: 1,
      endLedger: 2,
    };
    indexArcBurns.mockResolvedValue("arc-burns");
    indexArcMints.mockResolvedValue("arc-mints");
    indexStellarBurns.mockResolvedValue("stellar-burns");
    indexStellarMints.mockResolvedValue("stellar-mints");

    expect(await runtime.indexArcBurns(arc)).toBe("arc-burns");
    expect(await runtime.indexArcMints(arc)).toBe("arc-mints");
    expect(await runtime.indexStellarBurns(stellar)).toBe("stellar-burns");
    expect(await runtime.indexStellarMints(stellar)).toBe("stellar-mints");

    expect(indexArcBurns).toHaveBeenCalledWith(store, arc);
    expect(indexArcMints).toHaveBeenCalledWith(store, arc);
    expect(indexStellarBurns).toHaveBeenCalledWith(store, stellar);
    expect(indexStellarMints).toHaveBeenCalledWith(store, stellar);
  });

  it("passes each sync call to its sync function with the store", async () => {
    const runtime = createSettlementRuntime(store, { kernel });
    const cursorStore = {} as never;
    const arc = {
      network: "testnet" as const,
      startBlock: 1n,
      confirmations: 0,
      cursorStore,
    };
    const stellar = {
      network: "testnet" as const,
      startLedger: 1,
      cursorStore,
    };
    syncArcBurns.mockResolvedValue("sync-arc-burns");
    syncArcMints.mockResolvedValue("sync-arc-mints");
    syncStellarBurns.mockResolvedValue("sync-stellar-burns");
    syncStellarMints.mockResolvedValue("sync-stellar-mints");

    expect(await runtime.syncArcBurns(arc)).toBe("sync-arc-burns");
    expect(await runtime.syncArcMints(arc)).toBe("sync-arc-mints");
    expect(await runtime.syncStellarBurns(stellar)).toBe("sync-stellar-burns");
    expect(await runtime.syncStellarMints(stellar)).toBe("sync-stellar-mints");

    expect(syncArcBurns).toHaveBeenCalledWith(store, arc);
    expect(syncArcMints).toHaveBeenCalledWith(store, arc);
    expect(syncStellarBurns).toHaveBeenCalledWith(store, stellar);
    expect(syncStellarMints).toHaveBeenCalledWith(store, stellar);
  });

  it("delegates execute, reconcile, and resolveBurn", async () => {
    const runtime = createSettlementRuntime(store, { kernel });
    executeTransfer.mockResolvedValue("executed");
    reconcileTransfer.mockResolvedValue("reconciled");
    const params = { from: "arc" } as never;
    const executeOptions = { idempotencyKey: "k" };
    const reconcileOptions = { idempotencyKey: "k" } as never;

    expect(await runtime.execute(params, executeOptions)).toBe("executed");
    expect(await runtime.reconcile(reconcileOptions)).toBe("reconciled");
    expect(await runtime.resolveBurn({} as never)).toEqual({ resolved: true });

    expect(executeTransfer).toHaveBeenCalledWith(
      kernel,
      store,
      params,
      executeOptions,
    );
    expect(reconcileTransfer).toHaveBeenCalledWith(store, reconcileOptions);
  });
});
