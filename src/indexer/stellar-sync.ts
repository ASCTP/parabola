import { rpc } from "@stellar/stellar-sdk";
import type { Hex } from "viem";
import { stellarConfig } from "../constants.js";
import type { TransferStore } from "../execution/contracts.js";
import type { Network } from "../types.js";
import type { IndexerCursor, IndexerCursorStore } from "./cursor.js";
import type {
  IndexerSummary,
  StellarBurnIndexOptions,
  StellarEventReader,
  StellarMintIndexOptions,
} from "./contracts.js";
import { IndexerCursorError } from "./errors.js";
import { indexStellarBurns } from "./stellar-burns.js";
import { indexStellarMints } from "./stellar-mints.js";

export interface StellarLedgerReader {
  getLatestLedger(): Promise<{ sequence: number; hash: string }>;
  getLedger(
    sequence: number,
  ): Promise<{ sequence: number; hash: string } | undefined>;
}

export interface StellarSyncOptions {
  network: Network;
  startLedger: number;
  rpcUrl?: string;
  cursorStore: IndexerCursorStore;
  stream?: string;
  ledgerReader?: StellarLedgerReader;
  eventReader?: StellarEventReader;
}

export interface StellarSyncResult {
  summary: IndexerSummary;
  fromLedger: number;
  toLedger: number;
  cursor?: IndexerCursor;
}

type StellarIndexer = (
  store: TransferStore,
  options: StellarBurnIndexOptions | StellarMintIndexOptions,
) => Promise<IndexerSummary>;

function emptySummary(): IndexerSummary {
  return {
    reconciled: [],
    unmatched: [],
    ambiguous: [],
    skipped: [],
    busy: [],
  };
}

function normalizeLedgerHash(hash: string): Hex {
  const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new IndexerCursorError(`Invalid ledger hash: ${hash}`);
  }
  return normalized as Hex;
}

function stellarLedgerReader(
  network: Network,
  rpcUrl?: string,
): StellarLedgerReader {
  const server = new rpc.Server(
    rpcUrl ?? stellarConfig(network).sorobanRpcUrl,
  );

  return {
    getLatestLedger: async () => {
      const response = await server.getLatestLedger();
      return { sequence: response.sequence, hash: response.id };
    },
    getLedger: async (sequence) => {
      const response = await server.getLedgers({
        startLedger: sequence,
        pagination: { limit: 1 },
      });
      const ledger = response.ledgers.find(
        (entry) => entry.sequence === sequence,
      );
      return ledger
        ? { sequence: ledger.sequence, hash: ledger.hash }
        : undefined;
    },
  };
}

async function syncStellarIndexer(
  store: TransferStore,
  options: StellarSyncOptions,
  stream: string,
  index: StellarIndexer,
): Promise<StellarSyncResult> {
  if (
    !Number.isInteger(options.startLedger) ||
    options.startLedger < 0
  ) {
    throw new RangeError("startLedger must be a non-negative integer");
  }

  const reader =
    options.ledgerReader ??
    stellarLedgerReader(options.network, options.rpcUrl);
  const latest = await reader.getLatestLedger();
  const tip = latest.sequence;
  if (tip < options.startLedger) {
    return {
      summary: emptySummary(),
      fromLedger: options.startLedger,
      toLedger: tip,
    };
  }

  const existing = await options.cursorStore.get(stream);
  let fromLedger = options.startLedger;

  if (existing) {
    const cursorSequence = Number(existing.blockNumber);
    if (cursorSequence > tip) {
      throw new IndexerCursorError(
        `Cursor ledger ${cursorSequence} for ${stream} is ahead of the latest ledger ${tip}`,
      );
    }

    const cursorLedger = await reader.getLedger(cursorSequence);
    if (!cursorLedger) {
      throw new IndexerCursorError(
        `Cursor ledger ${cursorSequence} for ${stream} was not found on ${options.network}`,
      );
    }
    if (
      normalizeLedgerHash(cursorLedger.hash).toLowerCase() !==
      existing.blockHash.toLowerCase()
    ) {
      throw new IndexerCursorError(
        `Cursor ledger ${cursorSequence} for ${stream} no longer matches the canonical ledger`,
      );
    }

    if (cursorSequence === tip) {
      return {
        summary: emptySummary(),
        fromLedger: tip + 1,
        toLedger: tip,
        cursor: existing,
      };
    }
    fromLedger = cursorSequence + 1;
  }

  const summary = await index(store, {
    network: options.network,
    startLedger: fromLedger,
    endLedger: tip,
    rpcUrl: options.rpcUrl,
    reader: options.eventReader,
  });

  const tipLedger = await reader.getLedger(tip);
  if (!tipLedger) {
    throw new IndexerCursorError(
      `Tip ledger ${tip} for ${stream} was not found on ${options.network}`,
    );
  }

  const cursor: IndexerCursor = {
    stream,
    blockNumber: BigInt(tip),
    blockHash: normalizeLedgerHash(tipLedger.hash),
    updatedAt: Date.now(),
  };
  await options.cursorStore.put(cursor);

  return {
    summary,
    fromLedger,
    toLedger: tip,
    cursor,
  };
}

export async function syncStellarBurns(
  store: TransferStore,
  options: StellarSyncOptions,
): Promise<StellarSyncResult> {
  const stream = options.stream ?? `stellar:${options.network}:burns`;
  return syncStellarIndexer(store, options, stream, indexStellarBurns);
}

export async function syncStellarMints(
  store: TransferStore,
  options: StellarSyncOptions,
): Promise<StellarSyncResult> {
  const stream = options.stream ?? `stellar:${options.network}:mints`;
  return syncStellarIndexer(store, options, stream, indexStellarMints);
}
