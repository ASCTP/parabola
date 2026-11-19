import { Address, nativeToScVal, type rpc, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import { STELLAR_MAINNET, STELLAR_TESTNET } from "../../src/constants.js";
import type { StellarEventReader } from "../../src/indexer/contracts.js";
import { InvalidLedgerRangeError } from "../../src/indexer/errors.js";
import {
  indexStellarMints,
  readStellarMints,
} from "../../src/indexer/stellar-mints.js";

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const BURN_HASH = `0x${"a".repeat(64)}` as const;
const MINT_HASH = "stellar-mint-1";
const OTHER_MINT_HASH = "stellar-mint-2";

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burned",
    from: "arc",
    to: "stellar",
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

function event(
  overrides: {
    txHash?: string;
    forwardRecipient?: string;
    token?: string;
    amount?: bigint;
    successful?: boolean;
  } = {},
): rpc.Api.EventResponse {
  const forwardRecipient = overrides.forwardRecipient ?? RECIPIENT;
  const token = overrides.token ?? STELLAR_MAINNET.usdc;
  const amount = overrides.amount ?? 100_000_000n;

  return {
    id: "event-1",
    type: "contract",
    ledger: 11,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: overrides.successful ?? true,
    txHash: overrides.txHash ?? MINT_HASH,
    topic: [nativeToScVal("mint_and_forward", { type: "symbol" })],
    value: xdr.ScVal.scvVec([
      Address.fromString(forwardRecipient).toScVal(),
      Address.fromString(token).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ]),
  } as unknown as rpc.Api.EventResponse;
}

function reader(
  events: rpc.Api.EventResponse[],
  cursor = "",
): StellarEventReader & { getEvents: ReturnType<typeof vi.fn> } {
  return {
    getEvents: vi.fn().mockResolvedValue({
      events,
      cursor,
      latestLedger: 100,
      oldestLedger: 1,
      latestLedgerCloseTime: "",
      oldestLedgerCloseTime: "",
    }),
  } as unknown as StellarEventReader & {
    getEvents: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Stellar mint indexer", () => {
  it("reconciles a burned record from a matching mint_and_forward event", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event()]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "minted",
      burnTxHash: BURN_HASH,
      mintTxHash: MINT_HASH,
    });
    expect(source.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: "contract",
            contractIds: [STELLAR_MAINNET.cctpForwarder],
          },
        ],
        startLedger: 10,
        endLedger: 20,
      }),
    );
  });

  it("does not read events when there are no candidates", async () => {
    const store = new MemoryTransferStore();
    const source = reader([]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toEqual([]);
    expect(source.getEvents).not.toHaveBeenCalled();
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
      record({ idempotencyKey: "stellar", from: "stellar", to: "arc" }),
    );
    const source = reader([]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toEqual([]);
    expect(source.getEvents).not.toHaveBeenCalled();
  });

  it("reports a record with no matching mint", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event({ amount: 90_000_000n })]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burned" });
  });

  it("reports ambiguous matches without reconciling", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([
      event({ txHash: MINT_HASH }),
      event({ txHash: OTHER_MINT_HASH }),
    ]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.ambiguous).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burned" });
  });

  it("ignores a mint with a different recipient or token", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([
      event({ forwardRecipient: STELLAR_MAINNET.cctpForwarder }),
      event({ txHash: OTHER_MINT_HASH, token: STELLAR_TESTNET.usdc }),
    ]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });

  it("reports a record whose lease is held by another owner", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    await store.claim("order-1", "other-owner", 60_000);
    const source = reader([event()]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.busy).toEqual(["order-1"]);
  });

  it("uses testnet contracts when indexing testnet", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ network: "testnet" }));
    const source = reader([event({ token: STELLAR_TESTNET.usdc })]);

    const summary = await indexStellarMints(store, {
      network: "testnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(source.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: "contract",
            contractIds: [STELLAR_TESTNET.cctpForwarder],
          },
        ],
      }),
    );
  });

  it("rejects a reversed ledger range", async () => {
    const store = new MemoryTransferStore();

    await expect(
      indexStellarMints(store, {
        network: "mainnet",
        startLedger: 20,
        endLedger: 10,
        reader: reader([]),
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerRangeError);
  });

  it("ignores failed contract calls", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event({ successful: false })]);

    const summary = await indexStellarMints(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });

  it("paginates until the ledger range is exhausted", async () => {
    const source = {
      getEvents: vi
        .fn()
        .mockResolvedValueOnce({
          events: Array.from({ length: 200 }, (_, index) =>
            event({ txHash: `mint-${index}` }),
          ),
          cursor: "cursor-1",
          latestLedger: 100,
          oldestLedger: 1,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        })
        .mockResolvedValueOnce({
          events: [event({ txHash: OTHER_MINT_HASH })],
          cursor: "cursor-2",
          latestLedger: 100,
          oldestLedger: 1,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        }),
    } as unknown as StellarEventReader;

    const mints = await readStellarMints({
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(mints).toHaveLength(201);
    expect(
      source.getEvents as ReturnType<typeof vi.fn>,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-1", limit: 200 }),
    );
  });
});
