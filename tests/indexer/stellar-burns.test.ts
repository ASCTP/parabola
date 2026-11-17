import {
  Address,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import { InvalidLedgerRangeError } from "../../src/indexer/errors.js";
import {
  indexStellarBurns,
  readStellarBurns,
} from "../../src/indexer/stellar-burns.js";
import {
  ARC_DOMAIN,
  STELLAR_MAINNET,
  STELLAR_TESTNET,
} from "../../src/constants.js";
import { evmAddressToBytes32 } from "../../src/utils/encoding.js";
import type { StellarEventReader } from "../../src/indexer/contracts.js";

const DEPOSITOR =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const MINT_RECIPIENT = evmAddressToBytes32(RECIPIENT);
const BURN_HASH = "stellar-burn-1";
const OTHER_BURN_HASH = "stellar-burn-2";

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burning",
    from: "stellar",
    to: "arc",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    sourceAddress: DEPOSITOR,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function event(
  overrides: {
    txHash?: string;
    ledger?: number;
    burnToken?: string;
    depositor?: string;
    amount?: bigint;
    mintRecipient?: string;
    destinationDomain?: number;
    successful?: boolean;
  } = {},
): rpc.Api.EventResponse {
  const burnToken = overrides.burnToken ?? STELLAR_MAINNET.usdc;
  const depositor = overrides.depositor ?? DEPOSITOR;
  const amount = overrides.amount ?? 10_000_000n;
  const mintRecipient =
    overrides.mintRecipient ?? MINT_RECIPIENT;
  const destinationDomain = overrides.destinationDomain ?? ARC_DOMAIN;

  return {
    id: "event-1",
    type: "contract",
    ledger: overrides.ledger ?? 11,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: overrides.successful ?? true,
    txHash: overrides.txHash ?? BURN_HASH,
    topic: [
      nativeToScVal("deposit_for_burn", { type: "symbol" }),
      Address.fromString(burnToken).toScVal(),
      Address.fromString(depositor).toScVal(),
      nativeToScVal(2000, { type: "u32" }),
    ],
    value: xdr.ScVal.scvVec([
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(Buffer.from(mintRecipient.slice(2), "hex"), {
        type: "bytes",
      }),
      nativeToScVal(destinationDomain, { type: "u32" }),
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(0n, { type: "i128" }),
      nativeToScVal(Buffer.alloc(0), { type: "bytes" }),
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

describe("Stellar burn indexer", () => {
  it("reconciles a burning record from a matching deposit event", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event()]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "burned",
      burnTxHash: BURN_HASH,
    });
    expect(source.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: "contract",
            contractIds: [STELLAR_MAINNET.tokenMessengerMinter],
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

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toEqual([]);
    expect(source.getEvents).not.toHaveBeenCalled();
  });

  it("ignores records that are not burning Stellar-to-Arc transfers", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ idempotencyKey: "minted", phase: "minted" }));
    await store.create(
      record({ idempotencyKey: "arc", from: "arc", to: "stellar" }),
    );
    const source = reader([]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.reconciled).toEqual([]);
    expect(source.getEvents).not.toHaveBeenCalled();
  });

  it("reports a record with no matching burn", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event({ amount: 9_000_000n })]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("reports ambiguous matches without reconciling", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([
      event({ txHash: BURN_HASH }),
      event({ txHash: OTHER_BURN_HASH }),
    ]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.ambiguous).toEqual(["order-1"]);
    expect(await store.get("order-1")).toMatchObject({ phase: "burning" });
  });

  it("skips records without a source address", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ sourceAddress: undefined }));
    const source = reader([event()]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.skipped).toEqual(["order-1"]);
  });

  it("reports a record whose lease is held by another owner", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    await store.claim("order-1", "other-owner", 60_000);
    const source = reader([event()]);

    const summary = await indexStellarBurns(store, {
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
    const source = reader([event({ burnToken: STELLAR_TESTNET.usdc })]);

    const summary = await indexStellarBurns(store, {
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
            contractIds: [STELLAR_TESTNET.tokenMessengerMinter],
          },
        ],
      }),
    );
  });

  it("rejects a reversed ledger range", async () => {
    const store = new MemoryTransferStore();

    await expect(
      indexStellarBurns(store, {
        network: "mainnet",
        startLedger: 20,
        endLedger: 10,
        reader: reader([]),
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerRangeError);
  });

  it("paginates until the ledger range is exhausted", async () => {
    const source = {
      getEvents: vi
        .fn()
        .mockResolvedValueOnce({
          events: Array.from({ length: 200 }, (_, index) =>
            event({ txHash: `burn-${index}` }),
          ),
          cursor: "cursor-1",
          latestLedger: 100,
          oldestLedger: 1,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        })
        .mockResolvedValueOnce({
          events: [event({ txHash: OTHER_BURN_HASH })],
          cursor: "cursor-2",
          latestLedger: 100,
          oldestLedger: 1,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        }),
    } as unknown as StellarEventReader;

    const burns = await readStellarBurns({
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(burns).toHaveLength(201);
    expect((source.getEvents as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-1", limit: 200 }),
    );
  });

  it("stops at events beyond the requested ledger range", async () => {
    const source = {
      getEvents: vi
        .fn()
        .mockResolvedValueOnce({
          events: Array.from({ length: 200 }, () => event({ ledger: 21 })),
          cursor: "cursor-1",
          latestLedger: 100,
          oldestLedger: 1,
          latestLedgerCloseTime: "",
          oldestLedgerCloseTime: "",
        }),
    } as unknown as StellarEventReader;

    const burns = await readStellarBurns({
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(burns).toHaveLength(0);
    expect(source.getEvents).toHaveBeenCalledTimes(1);
  });

  it("ignores failed contract calls", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const source = reader([event({ successful: false })]);

    const summary = await indexStellarBurns(store, {
      network: "mainnet",
      startLedger: 10,
      endLedger: 20,
      reader: source,
    });

    expect(summary.unmatched).toEqual(["order-1"]);
  });
});
