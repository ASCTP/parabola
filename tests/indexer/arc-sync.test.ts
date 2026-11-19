import { concat, numberToHex, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import type { ArcBlockReader } from "../../src/indexer/arc-sync.js";

const getLogs = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getLogs }),
  };
});

const { MemoryTransferStore } = await import(
  "../../src/execution/memory-store.js"
);
const { MemoryIndexerCursorStore } = await import(
  "../../src/indexer/cursor.js"
);
const { syncArcBurns, syncArcMints } = await import(
  "../../src/indexer/arc-sync.js"
);
const { IndexerCursorError } = await import("../../src/indexer/errors.js");
const { ARC_MAINNET, STELLAR_DOMAIN, stellarConfig } = await import(
  "../../src/constants.js"
);
const {
  encodeStellarForwardHook,
  evmAddressToBytes32,
  stellarAddressToBytes32,
} = await import("../../src/utils/encoding.js");

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const EVM_RECIPIENT = "0x2222222222222222222222222222222222222222";
const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const BURN_HASH = `0x${"a".repeat(64)}` as const;
const MINT_HASH = `0x${"b".repeat(64)}` as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

function blockHash(blockNumber: bigint): Hex {
  return `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex;
}

function reader(
  latest: bigint,
  hashes: Map<bigint, Hex>,
): ArcBlockReader & {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
} {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(latest),
    getBlock: vi.fn(async (blockNumber: bigint) =>
      hashes.has(blockNumber)
        ? { hash: hashes.get(blockNumber) as Hex }
        : undefined,
    ),
  } as unknown as ArcBlockReader & {
    getBlockNumber: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
  };
}

function burnRecord(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burning",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    sourceAddress: DEPOSITOR,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function mintRecord(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burned",
    from: "stellar",
    to: "arc",
    network: "mainnet",
    amount: "10",
    recipient: EVM_RECIPIENT,
    sourceAddress: RECIPIENT,
    burnTxHash: BURN_HASH,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function burnArgs() {
  return {
    burnToken: ARC_MAINNET.usdc,
    amount: 10_000_000n,
    depositor: DEPOSITOR,
    mintRecipient: stellarAddressToBytes32(
      stellarConfig("mainnet").cctpForwarder,
    ),
    destinationDomain: STELLAR_DOMAIN,
    destinationTokenMessenger: ZERO_BYTES32,
    destinationCaller: ZERO_BYTES32,
    maxFee: 100n,
    minFinalityThreshold: 2000,
    hookData: encodeStellarForwardHook(RECIPIENT),
  };
}

function burnLog(transactionHash: Hex) {
  return { transactionHash, blockNumber: 95n, args: burnArgs() };
}

function mintBody(): Hex {
  return concat([
    numberToHex(1, { size: 4 }),
    stellarAddressToBytes32(stellarConfig("mainnet").usdc),
    evmAddressToBytes32(EVM_RECIPIENT),
    numberToHex(10_000_000n, { size: 32 }),
    ZERO_BYTES32,
    ZERO_BYTES32,
    ZERO_BYTES32,
    ZERO_BYTES32,
  ]);
}

function mintLog(transactionHash: Hex) {
  return {
    transactionHash,
    blockNumber: 100n,
    args: {
      caller: ARC_MAINNET.messageTransmitterV2,
      sourceDomain: STELLAR_DOMAIN,
      nonce: `0x${"11".repeat(32)}`,
      sender: stellarAddressToBytes32(
        stellarConfig("mainnet").tokenMessengerMinter,
      ),
      finalityThresholdExecuted: 2000,
      messageBody: mintBody(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLogs.mockResolvedValue([]);
});

describe("Arc cursor sync", () => {
  it("scans from the start block to the safe tip and writes a cursor", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const hashes = new Map([[95n, blockHash(95n)]]);
    const source = reader(100n, hashes);

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 5,
      cursorStore: cursors,
      reader: source,
    });

    expect(result).toMatchObject({
      fromBlock: 90n,
      toBlock: 95n,
      rewound: false,
    });
    expect(result.cursor).toMatchObject({
      stream: "arc:mainnet:burns",
      blockNumber: 95n,
      blockHash: blockHash(95n),
    });
    expect(await cursors.get("arc:mainnet:burns")).toEqual(result.cursor);
  });

  it("resumes after a canonical cursor", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "arc:mainnet:burns",
      blockNumber: 95n,
      blockHash: blockHash(95n),
      updatedAt: 1,
    });
    const source = reader(
      105n,
      new Map([
        [95n, blockHash(95n)],
        [100n, blockHash(100n)],
      ]),
    );

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 5,
      cursorStore: cursors,
      reader: source,
    });

    expect(result).toMatchObject({
      fromBlock: 96n,
      toBlock: 100n,
      rewound: false,
    });
  });

  it("does no work when the cursor is already at the safe tip", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const cursor = {
      stream: "arc:mainnet:burns",
      blockNumber: 100n,
      blockHash: blockHash(100n),
      updatedAt: 1,
    };
    await cursors.put(cursor);
    const source = reader(105n, new Map([[100n, blockHash(100n)]]));

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 5,
      cursorStore: cursors,
      reader: source,
    });

    expect(result.summary.reconciled).toEqual([]);
    expect(result.fromBlock).toBe(101n);
    expect(result.toBlock).toBe(100n);
    expect(result.cursor).toEqual(cursor);
    expect(source.getBlock).toHaveBeenCalledTimes(1);
  });

  it("rewinds by the configured window when the cursor block was reorged", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "arc:mainnet:burns",
      blockNumber: 95n,
      blockHash: `0x${"c".repeat(64)}`,
      updatedAt: 1,
    });
    const source = reader(
      105n,
      new Map([
        [92n, blockHash(92n)],
        [95n, blockHash(95n)],
        [100n, blockHash(100n)],
      ]),
    );

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 5,
      reorgWindow: 3n,
      cursorStore: cursors,
      reader: source,
    });

    expect(result).toMatchObject({
      fromBlock: 92n,
      toBlock: 100n,
      rewound: true,
    });
  });

  it("rewinds to the start block when the reorg window is deeper than the cursor", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "arc:mainnet:burns",
      blockNumber: 2n,
      blockHash: `0x${"c".repeat(64)}`,
      updatedAt: 1,
    });
    const source = reader(
      105n,
      new Map([
        [0n, blockHash(0n)],
        [2n, blockHash(2n)],
        [100n, blockHash(100n)],
      ]),
    );

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 0n,
      confirmations: 5,
      reorgWindow: 10n,
      cursorStore: cursors,
      reader: source,
    });

    expect(result).toMatchObject({
      fromBlock: 0n,
      toBlock: 100n,
      rewound: true,
    });
  });

  it("rewinds when the cursor is ahead of the safe tip", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "arc:mainnet:burns",
      blockNumber: 200n,
      blockHash: blockHash(200n),
      updatedAt: 1,
    });
    const source = reader(105n, new Map([[100n, blockHash(100n)]]));

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 5,
      reorgWindow: 2n,
      cursorStore: cursors,
      reader: source,
    });

    expect(result).toMatchObject({
      fromBlock: 100n,
      toBlock: 100n,
      rewound: true,
    });
  });

  it("throws when the cursor block is no longer available", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "arc:mainnet:burns",
      blockNumber: 95n,
      blockHash: blockHash(95n),
      updatedAt: 1,
    });
    const source = reader(105n, new Map([[100n, blockHash(100n)]]));

    await expect(
      syncArcBurns(store, {
        network: "mainnet",
        startBlock: 90n,
        confirmations: 5,
        cursorStore: cursors,
        reader: source,
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("throws when the tip block is not available", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(100n, new Map());

    await expect(
      syncArcBurns(store, {
        network: "mainnet",
        startBlock: 90n,
        confirmations: 0,
        cursorStore: cursors,
        reader: source,
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("does no work when the safe tip is below the start block", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(10n, new Map());

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 20n,
      confirmations: 5,
      cursorStore: cursors,
      reader: source,
    });

    expect(result.cursor).toBeUndefined();
    expect(result.fromBlock).toBe(20n);
    expect(result.toBlock).toBe(5n);
    expect(source.getBlock).not.toHaveBeenCalled();
  });

  it("rejects invalid confirmation and reorg settings", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(100n, new Map());

    await expect(
      syncArcBurns(store, {
        network: "mainnet",
        startBlock: 90n,
        confirmations: -1,
        cursorStore: cursors,
        reader: source,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      syncArcBurns(store, {
        network: "mainnet",
        startBlock: 90n,
        confirmations: 0,
        reorgWindow: -1n,
        cursorStore: cursors,
        reader: source,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("uses a custom stream key", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(100n, new Map([[100n, blockHash(100n)]]));

    await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 0,
      cursorStore: cursors,
      stream: "custom-stream",
      reader: source,
    });

    expect(await cursors.get("custom-stream")).toMatchObject({
      blockNumber: 100n,
    });
  });

  it("reconciles a matching burn while advancing the cursor", async () => {
    getLogs.mockResolvedValue([burnLog(BURN_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(burnRecord());
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(100n, new Map([[100n, blockHash(100n)]]));

    const result = await syncArcBurns(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 0,
      cursorStore: cursors,
      reader: source,
    });

    expect(result.summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "burned",
      burnTxHash: BURN_HASH,
    });
    expect(await cursors.get("arc:mainnet:burns")).toMatchObject({
      blockNumber: 100n,
    });
  });

  it("reconciles a matching mint while advancing the cursor", async () => {
    getLogs.mockResolvedValue([mintLog(MINT_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(mintRecord());
    const cursors = new MemoryIndexerCursorStore();
    const source = reader(100n, new Map([[100n, blockHash(100n)]]));

    const result = await syncArcMints(store, {
      network: "mainnet",
      startBlock: 90n,
      confirmations: 0,
      cursorStore: cursors,
      reader: source,
    });

    expect(result.summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "minted",
      mintTxHash: MINT_HASH,
    });
    expect(await cursors.get("arc:mainnet:mints")).toMatchObject({
      blockNumber: 100n,
    });
  });
});
