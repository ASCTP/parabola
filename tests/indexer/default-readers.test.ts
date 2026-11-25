import { BlockNotFoundError } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBlockNumber = vi.fn();
const getBlock = vi.fn();
const getLatestLedger = vi.fn();
const getLedgers = vi.fn();
const serverUrls: string[] = [];

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getBlockNumber, getBlock, getLogs: vi.fn() }),
  };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    constructor(url: string) {
      serverUrls.push(url);
    }
    getLatestLedger = getLatestLedger;
    getLedgers = getLedgers;
    getEvents = vi.fn().mockResolvedValue({ events: [] });
  }
  return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } };
});

const { MemoryTransferStore } = await import(
  "../../src/execution/memory-store.js"
);
const { MemoryIndexerCursorStore } = await import(
  "../../src/indexer/cursor.js"
);
const { syncArcBurns } = await import("../../src/indexer/arc-sync.js");
const { syncStellarMints } = await import("../../src/indexer/stellar-sync.js");
const { IndexerCursorError } = await import("../../src/indexer/errors.js");
const { stellarConfig } = await import("../../src/constants.js");

const HASH_A = `0x${"a".repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  serverUrls.length = 0;
});

describe("default Arc block reader", () => {
  it("reads the tip and the cursor block from the RPC client", async () => {
    getBlockNumber.mockResolvedValue(120n);
    getBlock.mockResolvedValue({ hash: HASH_A });
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();

    const first = await syncArcBurns(store, {
      network: "testnet",
      startBlock: 100n,
      confirmations: 0,
      cursorStore: cursors,
    });
    expect(first.toBlock).toBe(120n);
    expect(first.cursor?.blockHash).toBe(HASH_A);

    const second = await syncArcBurns(store, {
      network: "testnet",
      startBlock: 100n,
      confirmations: 0,
      cursorStore: cursors,
    });
    expect(second.fromBlock).toBeGreaterThanOrEqual(120n);
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: 120n });
  });

  it("selects the mainnet chain when asked", async () => {
    getBlockNumber.mockResolvedValue(10n);
    getBlock.mockResolvedValue({ hash: HASH_A });

    const result = await syncArcBurns(new MemoryTransferStore(), {
      network: "mainnet",
      startBlock: 5n,
      confirmations: 0,
      cursorStore: new MemoryIndexerCursorStore(),
      rpcUrl: "http://localhost:1",
    });

    expect(result.toBlock).toBe(10n);
  });

  it("treats a missing block as undefined", async () => {
    getBlockNumber.mockResolvedValue(50n);
    getBlock.mockRejectedValue(new BlockNotFoundError({ blockNumber: 50n }));

    await expect(
      syncArcBurns(new MemoryTransferStore(), {
        network: "testnet",
        startBlock: 40n,
        confirmations: 0,
        cursorStore: new MemoryIndexerCursorStore(),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("rethrows other block read failures", async () => {
    getBlockNumber.mockResolvedValue(50n);
    getBlock.mockRejectedValue(new Error("rpc down"));

    await expect(
      syncArcBurns(new MemoryTransferStore(), {
        network: "testnet",
        startBlock: 40n,
        confirmations: 0,
        cursorStore: new MemoryIndexerCursorStore(),
      }),
    ).rejects.toThrow("rpc down");
  });

  it("treats a block without a hash as missing", async () => {
    getBlockNumber.mockResolvedValue(50n);
    getBlock.mockResolvedValue({ hash: null });

    await expect(
      syncArcBurns(new MemoryTransferStore(), {
        network: "testnet",
        startBlock: 40n,
        confirmations: 0,
        cursorStore: new MemoryIndexerCursorStore(),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });
});

describe("default Stellar ledger reader", () => {
  const ledgerHash = "c".repeat(64);

  it("reads the latest ledger and the tip ledger through the RPC server", async () => {
    getLatestLedger.mockResolvedValue({ sequence: 200, id: ledgerHash });
    getLedgers.mockResolvedValue({
      ledgers: [{ sequence: 200, hash: ledgerHash }],
    });
    const cursors = new MemoryIndexerCursorStore();

    const result = await syncStellarMints(new MemoryTransferStore(), {
      network: "testnet",
      startLedger: 190,
      cursorStore: cursors,
    });

    expect(result.toLedger).toBe(200);
    expect(result.cursor?.blockHash).toBe(`0x${ledgerHash}`);
    expect(serverUrls[0]).toBe(stellarConfig("testnet").sorobanRpcUrl);
    expect(getLedgers).toHaveBeenCalledWith({
      startLedger: 200,
      pagination: { limit: 1 },
    });
  });

  it("uses a custom RPC url", async () => {
    getLatestLedger.mockResolvedValue({ sequence: 10, id: ledgerHash });
    getLedgers.mockResolvedValue({
      ledgers: [{ sequence: 10, hash: ledgerHash }],
    });

    await syncStellarMints(new MemoryTransferStore(), {
      network: "mainnet",
      startLedger: 5,
      cursorStore: new MemoryIndexerCursorStore(),
      rpcUrl: "https://rpc.example.test",
    });

    expect(serverUrls[0]).toBe("https://rpc.example.test");
  });

  it("treats a ledger missing from the page as undefined", async () => {
    getLatestLedger.mockResolvedValue({ sequence: 30, id: ledgerHash });
    getLedgers.mockResolvedValue({
      ledgers: [{ sequence: 31, hash: ledgerHash }],
    });

    await expect(
      syncStellarMints(new MemoryTransferStore(), {
        network: "testnet",
        startLedger: 20,
        cursorStore: new MemoryIndexerCursorStore(),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });
});
