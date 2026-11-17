import { concat, numberToHex, pad, type Hex } from "viem";
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
const { indexArcMints } = await import("../../src/indexer/arc-mints.js");
const { InvalidIndexerRangeError } = await import(
  "../../src/indexer/errors.js"
);
const { ARC_DOMAIN, ARC_MAINNET, ARC_TESTNET, STELLAR_DOMAIN, stellarConfig } =
  await import("../../src/constants.js");
const { evmAddressToBytes32, stellarAddressToBytes32 } = await import(
  "../../src/utils/encoding.js"
);

const RECIPIENT = "0x2222222222222222222222222222222222222222";
const DEPOSITOR =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const BURN_HASH = "stellar-burn-1";
const MINT_HASH = `0x${"a".repeat(64)}` as const;
const OTHER_MINT_HASH = `0x${"b".repeat(64)}` as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burned",
    from: "stellar",
    to: "arc",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    sourceAddress: DEPOSITOR,
    burnTxHash: BURN_HASH,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function burnBody(
  overrides: {
    burnToken?: Hex;
    mintRecipient?: Hex;
    amount?: bigint;
    hookData?: Hex;
  } = {},
): Hex {
  return concat([
    numberToHex(1, { size: 4 }),
    overrides.burnToken ??
      stellarAddressToBytes32(stellarConfig("mainnet").usdc),
    overrides.mintRecipient ?? evmAddressToBytes32(RECIPIENT),
    numberToHex(overrides.amount ?? 10_000_000n, { size: 32 }),
    ZERO_BYTES32,
    ZERO_BYTES32,
    ZERO_BYTES32,
    ZERO_BYTES32,
    overrides.hookData ?? "0x",
  ]);
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    caller: ARC_MAINNET.messageTransmitterV2,
    sourceDomain: STELLAR_DOMAIN,
    nonce: `0x${"11".repeat(32)}` as Hex,
    sender: stellarAddressToBytes32(
      stellarConfig("mainnet").tokenMessengerMinter,
    ),
    finalityThresholdExecuted: 2000,
    messageBody: burnBody(),
    ...overrides,
  };
}

function log(transactionHash: Hex, eventArgs = args()) {
  return { transactionHash, blockNumber: 1n, args: eventArgs };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLogs.mockResolvedValue([]);
});

describe("Arc mint indexer", () => {
  it("reconciles a burned record from a matching MessageReceived log", async () => {
    getLogs.mockResolvedValue([log(MINT_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(summary.unmatched).toEqual([]);
    expect(await store.get("order-1")).toMatchObject({
      phase: "minted",
      burnTxHash: BURN_HASH,
      mintTxHash: MINT_HASH,
    });
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ARC_MAINNET.messageTransmitterV2,
        fromBlock: 10n,
        toBlock: 20n,
      }),
    );
  });

  it("does not query logs when there are no candidates", async () => {
    const store = new MemoryTransferStore();

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("ignores records without a burn hash or with an existing mint hash", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({ idempotencyKey: "no-burn", burnTxHash: undefined }),
    );
    await store.create(
      record({ idempotencyKey: "minted", mintTxHash: MINT_HASH }),
    );
    await store.create(record({ idempotencyKey: "failed", phase: "failed" }));
    await store.create(
      record({ idempotencyKey: "arc", from: "arc", to: "stellar" }),
    );

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("reports a record with no matching mint", async () => {
    getLogs.mockResolvedValue([
      log(MINT_HASH, args({ messageBody: burnBody({ amount: 9_000_000n }) })),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burned" });
  });

  it("reports ambiguous matches without reconciling", async () => {
    getLogs.mockResolvedValue([
      log(MINT_HASH),
      log(OTHER_MINT_HASH),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.ambiguous).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burned" });
  });

  it("ignores a message carrying hook data", async () => {
    getLogs.mockResolvedValue([
      log(MINT_HASH, args({ messageBody: burnBody({ hookData: "0x1234" }) })),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });

  it("ignores unrelated source domains and senders", async () => {
    getLogs.mockResolvedValue([
      log(MINT_HASH, args({ sourceDomain: ARC_DOMAIN })),
      log(OTHER_MINT_HASH, args({ sender: ZERO_BYTES32 })),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });

  it("ignores a malformed message body instead of throwing", async () => {
    getLogs.mockResolvedValue([
      log(MINT_HASH, args({ messageBody: "0x1234" })),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record());

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });

  it("reports a record whose lease is held by another owner", async () => {
    getLogs.mockResolvedValue([log(MINT_HASH)]);
    const store = new MemoryTransferStore();
    await store.create(record());
    await store.claim("order-1", "other-owner", 60_000);

    const summary = await indexArcMints(store, {
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.busy).toEqual(["order-1"]);
  });

  it("uses testnet contracts when indexing testnet", async () => {
    getLogs.mockResolvedValue([
      log(
        MINT_HASH,
        args({
          sender: stellarAddressToBytes32(
            stellarConfig("testnet").tokenMessengerMinter,
          ),
          messageBody: burnBody({
            burnToken: stellarAddressToBytes32(
              stellarConfig("testnet").usdc,
            ),
          }),
        }),
      ),
    ]);
    const store = new MemoryTransferStore();
    await store.create(record({ network: "testnet" }));

    const summary = await indexArcMints(store, {
      network: "testnet",
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: ARC_TESTNET.messageTransmitterV2 }),
    );
  });

  it("rejects a reversed block range", async () => {
    const store = new MemoryTransferStore();

    await expect(
      indexArcMints(store, {
        network: "mainnet",
        fromBlock: 20n,
        toBlock: 10n,
      }),
    ).rejects.toBeInstanceOf(InvalidIndexerRangeError);
  });
});
