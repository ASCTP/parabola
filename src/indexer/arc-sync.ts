import {
  BlockNotFoundError,
  createPublicClient,
  http,
  type Hex,
} from "viem";
import { arcMainnetChain, arcTestnetChain } from "../chains/arc.js";
import { arcConfig } from "../constants.js";
import type { TransferStore } from "../execution/contracts.js";
import type { Network } from "../types.js";
import { indexArcBurns } from "./arc-burns.js";
import { indexArcMints } from "./arc-mints.js";
import type { IndexerCursor, IndexerCursorStore } from "./cursor.js";
import type {
  ArcBurnIndexOptions,
  ArcMintIndexOptions,
  IndexerSummary,
} from "./contracts.js";
import { IndexerCursorError } from "./errors.js";

export interface ArcBlockReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<{ hash: Hex } | undefined>;
}

export interface ArcSyncOptions {
  network: Network;
  startBlock: bigint;
  confirmations: number;
  reorgWindow?: bigint;
  rpcUrl?: string;
  cursorStore: IndexerCursorStore;
  stream?: string;
  reader?: ArcBlockReader;
}

export interface ArcSyncResult {
  summary: IndexerSummary;
  fromBlock: bigint;
  toBlock: bigint;
  cursor?: IndexerCursor;
  rewound: boolean;
}

type ArcIndexer = (
  store: TransferStore,
  options: ArcBurnIndexOptions | ArcMintIndexOptions,
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

function arcBlockReader(
  network: Network,
  rpcUrl?: string,
): ArcBlockReader {
  const arc = arcConfig(network);
  const chain = network === "mainnet" ? arcMainnetChain : arcTestnetChain;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl ?? arc.rpcUrl),
  });

  return {
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        return block.hash ? { hash: block.hash } : undefined;
      } catch (err) {
        if (err instanceof BlockNotFoundError) {
          return undefined;
        }
        throw err;
      }
    },
  };
}

function rewindFrom(
  cursor: IndexerCursor,
  reorgWindow: bigint,
  startBlock: bigint,
): bigint {
  const rewind = cursor.blockNumber - reorgWindow;
  return rewind < startBlock ? startBlock : rewind;
}

async function syncArcIndexer(
  store: TransferStore,
  options: ArcSyncOptions,
  stream: string,
  index: ArcIndexer,
): Promise<ArcSyncResult> {
  if (options.startBlock < 0n) {
    throw new RangeError("startBlock must not be negative");
  }
  if (!Number.isInteger(options.confirmations) || options.confirmations < 0) {
    throw new RangeError("confirmations must be a non-negative integer");
  }
  if ((options.reorgWindow ?? 0n) < 0n) {
    throw new RangeError("reorgWindow must not be negative");
  }

  const reader = options.reader ?? arcBlockReader(options.network, options.rpcUrl);
  const latest = await reader.getBlockNumber();
  const tip = latest - BigInt(options.confirmations);
  if (tip < options.startBlock) {
    return {
      summary: emptySummary(),
      fromBlock: options.startBlock,
      toBlock: tip,
      rewound: false,
    };
  }

  const existing = await options.cursorStore.get(stream);
  let fromBlock = options.startBlock;
  let rewound = false;

  if (existing) {
    if (existing.blockNumber > tip) {
      fromBlock = rewindFrom(existing, options.reorgWindow ?? 0n, options.startBlock);
      if (fromBlock > tip) {
        fromBlock = tip;
      }
      rewound = true;
    } else {
      const cursorBlock = await reader.getBlock(existing.blockNumber);
      if (!cursorBlock) {
        throw new IndexerCursorError(
          `Cursor block ${existing.blockNumber} for ${stream} was not found on ${options.network}`,
        );
      }
      if (
        cursorBlock.hash.toLowerCase() !== existing.blockHash.toLowerCase()
      ) {
        fromBlock = rewindFrom(
          existing,
          options.reorgWindow ?? 0n,
          options.startBlock,
        );
        rewound = true;
      } else if (existing.blockNumber === tip) {
        return {
          summary: emptySummary(),
          fromBlock: tip + 1n,
          toBlock: tip,
          cursor: existing,
          rewound: false,
        };
      } else {
        fromBlock = existing.blockNumber + 1n;
      }
    }
  }

  if (fromBlock > tip) {
    return {
      summary: emptySummary(),
      fromBlock,
      toBlock: tip,
      cursor: existing,
      rewound,
    };
  }

  const summary = await index(store, {
    network: options.network,
    fromBlock,
    toBlock: tip,
    rpcUrl: options.rpcUrl,
  });

  const tipBlock = await reader.getBlock(tip);
  if (!tipBlock) {
    throw new IndexerCursorError(
      `Tip block ${tip} for ${stream} was not found on ${options.network}`,
    );
  }

  const cursor: IndexerCursor = {
    stream,
    blockNumber: tip,
    blockHash: tipBlock.hash,
    updatedAt: Date.now(),
  };
  await options.cursorStore.put(cursor);

  return {
    summary,
    fromBlock,
    toBlock: tip,
    cursor,
    rewound,
  };
}

export async function syncArcBurns(
  store: TransferStore,
  options: ArcSyncOptions,
): Promise<ArcSyncResult> {
  const stream = options.stream ?? `arc:${options.network}:burns`;
  return syncArcIndexer(store, options, stream, indexArcBurns);
}

export async function syncArcMints(
  store: TransferStore,
  options: ArcSyncOptions,
): Promise<ArcSyncResult> {
  const stream = options.stream ?? `arc:${options.network}:mints`;
  return syncArcIndexer(store, options, stream, indexArcMints);
}
