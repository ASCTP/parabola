import { Address, nativeToScVal, type rpc, xdr } from "@stellar/stellar-sdk";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import {
  ARC_DOMAIN,
  STELLAR_MAINNET,
  stellarConfig,
} from "../../src/constants.js";
import type { StellarEventReader } from "../../src/indexer/contracts.js";
import { MemoryIndexerCursorStore } from "../../src/indexer/cursor.js";
import { IndexerCursorError } from "../../src/indexer/errors.js";
import {
  syncStellarBurns,
  syncStellarMints,
  type StellarLedgerReader,
} from "../../src/indexer/stellar-sync.js";
import { evmAddressToBytes32 } from "../../src/utils/encoding.js";

const STELLAR_RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const EVM_RECIPIENT = "0x2222222222222222222222222222222222222222";
const EVM_DEPOSITOR = "0x1111111111111111111111111111111111111111";
const BURN_HASH = "stellar-burn-1";
const MINT_HASH = "stellar-mint-1";

function ledgerHash(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

function normalizedLedgerHash(sequence: number): Hex {
  return `0x${ledgerHash(sequence)}`;
}

function ledgerReader(
  latest: number,
  hashes: Map<number, string>,
): StellarLedgerReader & {
  getLatestLedger: ReturnType<typeof vi.fn>;
  getLedger: ReturnType<typeof vi.fn>;
} {
  return {
    getLatestLedger: vi.fn().mockResolvedValue({
      sequence: latest,
      hash: hashes.get(latest) ?? ledgerHash(latest),
    }),
    getLedger: vi.fn(async (sequence: number) =>
      hashes.has(sequence)
        ? { sequence, hash: hashes.get(sequence) as string }
        : undefined,
    ),
  } as unknown as StellarLedgerReader & {
    getLatestLedger: ReturnType<typeof vi.fn>;
    getLedger: ReturnType<typeof vi.fn>;
  };
}

function eventReader(
  events: rpc.Api.EventResponse[],
): StellarEventReader & { getEvents: ReturnType<typeof vi.fn> } {
  return {
    getEvents: vi.fn().mockResolvedValue({
      events,
      cursor: "",
      latestLedger: 100,
      oldestLedger: 1,
      latestLedgerCloseTime: "",
      oldestLedgerCloseTime: "",
    }),
  } as unknown as StellarEventReader & {
    getEvents: ReturnType<typeof vi.fn>;
  };
}

function burnRecord(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burning",
    from: "stellar",
    to: "arc",
    network: "mainnet",
    amount: "10",
    recipient: EVM_RECIPIENT,
    sourceAddress: STELLAR_RECIPIENT,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function mintRecord(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burned",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: STELLAR_RECIPIENT,
    sourceAddress: EVM_DEPOSITOR,
    burnTxHash: BURN_HASH,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function burnEvent(txHash = BURN_HASH): rpc.Api.EventResponse {
  return {
    id: "event-1",
    type: "contract",
    ledger: 95,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash,
    topic: [
      nativeToScVal("deposit_for_burn", { type: "symbol" }),
      Address.fromString(STELLAR_MAINNET.usdc).toScVal(),
      Address.fromString(STELLAR_RECIPIENT).toScVal(),
      nativeToScVal(2000, { type: "u32" }),
    ],
    value: xdr.ScVal.scvVec([
      nativeToScVal(10_000_000n, { type: "i128" }),
      nativeToScVal(
        Buffer.from(evmAddressToBytes32(EVM_RECIPIENT).slice(2), "hex"),
        { type: "bytes" },
      ),
      nativeToScVal(ARC_DOMAIN, { type: "u32" }),
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(0n, { type: "i128" }),
      nativeToScVal(Buffer.alloc(0), { type: "bytes" }),
    ]),
  } as unknown as rpc.Api.EventResponse;
}

function mintEvent(txHash = MINT_HASH): rpc.Api.EventResponse {
  return {
    id: "event-1",
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash,
    topic: [nativeToScVal("mint_and_forward", { type: "symbol" })],
    value: xdr.ScVal.scvVec([
      Address.fromString(STELLAR_RECIPIENT).toScVal(),
      Address.fromString(stellarConfig("mainnet").usdc).toScVal(),
      nativeToScVal(100_000_000n, { type: "i128" }),
    ]),
  } as unknown as rpc.Api.EventResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Stellar cursor sync", () => {
  it("scans from the start ledger to the latest ledger and writes a cursor", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = ledgerReader(100, new Map([[100, ledgerHash(100)]]));
    const events = eventReader([]);

    const result = await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: events,
    });

    expect(result).toMatchObject({
      fromLedger: 90,
      toLedger: 100,
    });
    expect(result.cursor).toMatchObject({
      stream: "stellar:mainnet:burns",
      blockNumber: 100n,
      blockHash: normalizedLedgerHash(100),
    });
    expect(await cursors.get("stellar:mainnet:burns")).toEqual(result.cursor);
    expect(events.getEvents).not.toHaveBeenCalled();
  });

  it("resumes after a canonical cursor", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "stellar:mainnet:burns",
      blockNumber: 95n,
      blockHash: normalizedLedgerHash(95),
      updatedAt: 1,
    });
    const source = ledgerReader(
      105,
      new Map([
        [95, ledgerHash(95)],
        [105, ledgerHash(105)],
      ]),
    );

    const result = await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: eventReader([]),
    });

    expect(result).toMatchObject({
      fromLedger: 96,
      toLedger: 105,
    });
  });

  it("does no work when the cursor is already at the latest ledger", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const cursor = {
      stream: "stellar:mainnet:burns",
      blockNumber: 105n,
      blockHash: normalizedLedgerHash(105),
      updatedAt: 1,
    };
    await cursors.put(cursor);
    const source = ledgerReader(105, new Map([[105, ledgerHash(105)]]));

    const result = await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: eventReader([]),
    });

    expect(result.summary.reconciled).toEqual([]);
    expect(result.fromLedger).toBe(106);
    expect(result.toLedger).toBe(105);
    expect(result.cursor).toEqual(cursor);
    expect(source.getLedger).toHaveBeenCalledTimes(1);
  });

  it("throws when the cursor ledger is unavailable", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "stellar:mainnet:burns",
      blockNumber: 95n,
      blockHash: normalizedLedgerHash(95),
      updatedAt: 1,
    });

    await expect(
      syncStellarBurns(store, {
        network: "mainnet",
        startLedger: 90,
        cursorStore: cursors,
        ledgerReader: ledgerReader(105, new Map()),
        eventReader: eventReader([]),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("throws when the cursor ledger hash no longer matches", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "stellar:mainnet:burns",
      blockNumber: 95n,
      blockHash: normalizedLedgerHash(94),
      updatedAt: 1,
    });

    await expect(
      syncStellarBurns(store, {
        network: "mainnet",
        startLedger: 90,
        cursorStore: cursors,
        ledgerReader: ledgerReader(105, new Map([[95, ledgerHash(95)]])),
        eventReader: eventReader([]),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("throws when the cursor is ahead of the latest ledger", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    await cursors.put({
      stream: "stellar:mainnet:burns",
      blockNumber: 200n,
      blockHash: normalizedLedgerHash(200),
      updatedAt: 1,
    });

    await expect(
      syncStellarBurns(store, {
        network: "mainnet",
        startLedger: 90,
        cursorStore: cursors,
        ledgerReader: ledgerReader(105, new Map()),
        eventReader: eventReader([]),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("throws when the tip ledger is unavailable", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();

    await expect(
      syncStellarBurns(store, {
        network: "mainnet",
        startLedger: 90,
        cursorStore: cursors,
        ledgerReader: ledgerReader(100, new Map()),
        eventReader: eventReader([]),
      }),
    ).rejects.toBeInstanceOf(IndexerCursorError);
  });

  it("does no work when the latest ledger is below the start ledger", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = ledgerReader(10, new Map());

    const result = await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 20,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: eventReader([]),
    });

    expect(result.cursor).toBeUndefined();
    expect(result.fromLedger).toBe(20);
    expect(result.toLedger).toBe(10);
    expect(source.getLedger).not.toHaveBeenCalled();
  });

  it("rejects an invalid start ledger", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();

    await expect(
      syncStellarBurns(store, {
        network: "mainnet",
        startLedger: -1,
        cursorStore: cursors,
        ledgerReader: ledgerReader(100, new Map()),
        eventReader: eventReader([]),
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("uses a custom stream key", async () => {
    const store = new MemoryTransferStore();
    const cursors = new MemoryIndexerCursorStore();
    const source = ledgerReader(100, new Map([[100, ledgerHash(100)]]));

    await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      stream: "custom-stream",
      ledgerReader: source,
      eventReader: eventReader([]),
    });

    expect(await cursors.get("custom-stream")).toMatchObject({
      blockNumber: 100n,
    });
  });

  it("reconciles a matching burn while advancing the cursor", async () => {
    const store = new MemoryTransferStore();
    await store.create(burnRecord());
    const cursors = new MemoryIndexerCursorStore();
    const source = ledgerReader(100, new Map([[100, ledgerHash(100)]]));
    const events = eventReader([burnEvent()]);

    const result = await syncStellarBurns(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: events,
    });

    expect(result.summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "burned",
      burnTxHash: BURN_HASH,
    });
    expect(await cursors.get("stellar:mainnet:burns")).toMatchObject({
      blockNumber: 100n,
    });
  });

  it("reconciles a matching mint while advancing the cursor", async () => {
    const store = new MemoryTransferStore();
    await store.create(mintRecord());
    const cursors = new MemoryIndexerCursorStore();
    const source = ledgerReader(100, new Map([[100, ledgerHash(100)]]));
    const events = eventReader([mintEvent()]);

    const result = await syncStellarMints(store, {
      network: "mainnet",
      startLedger: 90,
      cursorStore: cursors,
      ledgerReader: source,
      eventReader: events,
    });

    expect(result.summary.reconciled).toHaveLength(1);
    expect(await store.get("order-1")).toMatchObject({
      phase: "minted",
      mintTxHash: MINT_HASH,
    });
    expect(await cursors.get("stellar:mainnet:mints")).toMatchObject({
      blockNumber: 100n,
    });
  });
});
