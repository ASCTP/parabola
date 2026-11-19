import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";

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
const { indexArcBurns } = await import("../../src/indexer/arc-burns.js");
const { InvalidIndexerRangeError } = await import(
  "../../src/indexer/errors.js"
);
const { ARC_MAINNET, ARC_TESTNET, STELLAR_DOMAIN, stellarConfig } =
  await import("../../src/constants.js");
const { encodeStellarForwardHook, stellarAddressToBytes32 } = await import(
  "../../src/utils/encoding.js"
);

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const BURN_HASH = `0x${"a".repeat(64)}` as const;
const OTHER_BURN_HASH = `0x${"b".repeat(64)}` as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
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

function args(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function log(transactionHash: `0x${string}`, eventArgs = args()) {
  return { transactionHash, blockNumber: 1n, args: eventArgs };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLogs.mockResolvedValue([]);
});

describe("Arc burn indexer", () => {
  it("reconciles a burning record from a matching DepositForBurn log", async () => {
    getLogs.mockResolvedValue([log(BURN_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(summary.unmatched).toEqual([]);
    expect(await store.get("order-1")).toMatchObject({
      phase: "burned",
      burnTxHash: BURN_HASH,
    });
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ARC_MAINNET.tokenMessengerV2,
        fromBlock: 10n,
        toBlock: 20n,
      }),
    );
  });

  it("does not query logs when there are no candidates", async () => {
    const store = new MemoryTransferStore();

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("ignores records that are not burning Arc-to-Stellar transfers", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ idempotencyKey: "minted", phase: "minted" }));
    await store.create(
      record({ idempotencyKey: "stellar", from: "stellar", to: "arc" }),
    );

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toEqual([]);
    expect(summary.unmatched).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("reports a record with no matching burn", async () => {
    getLogs.mockResolvedValue([log(BURN_HASH, args({ amount: 9_000_000n }))]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("reports ambiguous matches without reconciling", async () => {
    getLogs.mockResolvedValue([log(BURN_HASH), log(OTHER_BURN_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.ambiguous).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("skips records without a source address", async () => {
    getLogs.mockResolvedValue([log(BURN_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record({ sourceAddress: undefined }));

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.skipped).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("reports a record whose lease is held by another owner", async () => {
    getLogs.mockResolvedValue([log(BURN_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record());
    await store.claim("order-1", "other-owner", 60_000);

    const summary = await indexArcBurns(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.busy).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("uses testnet contracts when indexing testnet", async () => {
    getLogs.mockResolvedValue([
      log(BURN_HASH, {
        ...args(),
        burnToken: ARC_TESTNET.usdc,
        mintRecipient: stellarAddressToBytes32(
          stellarConfig("testnet").cctpForwarder,
        ),
      }),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record({ network: "testnet" }));

    const summary = await indexArcBurns(store, {
      network: "testnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: ARC_TESTNET.tokenMessengerV2 }),
    );
  });

  it("rejects a reversed block range", async () => {
    const store = new MemoryTransferStore();

    await expect(
      indexArcBurns(store, {
        network: "mainnet",
        fromBlock: 20n,
        toBlock: 10n,
      }),
    ).rejects.toBeInstanceOf(InvalidIndexerRangeError);
  });
});
