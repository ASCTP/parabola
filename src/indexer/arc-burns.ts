import { createPublicClient, http, type Hex } from "viem";
import { arcMainnetChain, arcTestnetChain } from "../chains/arc.js";
import {
  STELLAR_DOMAIN,
  arcConfig,
  stellarConfig,
} from "../constants.js";
import type { TransferRecord, TransferStore } from "../execution/contracts.js";
import {
  TransferConflictError,
} from "../execution/errors.js";
import {
  reconcileTransfer,
  type ReconcileTransferOutcome,
} from "../execution/reconciler.js";
import { toRawAmount } from "../utils/amount.js";
import {
  encodeStellarForwardHook,
  stellarAddressToBytes32,
} from "../utils/encoding.js";
import type {
  ArcBurnIndexOptions,
  IndexerSummary,
} from "./contracts.js";
import { InvalidIndexerRangeError } from "./errors.js";

const depositForBurnEvent = {
  type: "event",
  name: "DepositForBurn",
  inputs: [
    { name: "burnToken", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "depositor", type: "address", indexed: true },
    { name: "mintRecipient", type: "bytes32", indexed: false },
    { name: "destinationDomain", type: "uint32", indexed: false },
    { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
    { name: "destinationCaller", type: "bytes32", indexed: false },
    { name: "maxFee", type: "uint256", indexed: false },
    { name: "minFinalityThreshold", type: "uint32", indexed: true },
    { name: "hookData", type: "bytes", indexed: false },
  ],
} as const;

interface DepositForBurnArgs {
  burnToken: Hex;
  amount: bigint;
  depositor: Hex;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationTokenMessenger: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}

interface ArcBurnLog {
  transactionHash: Hex;
  args: DepositForBurnArgs;
}

interface ExpectedBurn {
  depositor: string;
  amountRaw: bigint;
  mintRecipient: Hex;
  hookData: Hex;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function expectedBurn(record: TransferRecord): ExpectedBurn {
  return {
    depositor: record.sourceAddress as string,
    amountRaw: toRawAmount(record.amount, "arc"),
    mintRecipient: stellarAddressToBytes32(
      stellarConfig(record.network).cctpForwarder,
    ),
    hookData: encodeStellarForwardHook(record.recipient),
  };
}

function matchesBurn(
  record: TransferRecord,
  expected: ExpectedBurn,
  args: DepositForBurnArgs,
): boolean {
  return (
    sameHex(args.burnToken, arcConfig(record.network).usdc) &&
    sameHex(args.depositor, expected.depositor) &&
    sameHex(args.mintRecipient, expected.mintRecipient) &&
    sameHex(args.hookData, expected.hookData) &&
    args.amount === expected.amountRaw &&
    args.destinationDomain === STELLAR_DOMAIN
  );
}

function isArcBurnCandidate(
  record: TransferRecord,
  network: ArcBurnIndexOptions["network"],
): boolean {
  return (
    record.from === "arc" &&
    record.to === "stellar" &&
    record.network === network &&
    record.phase === "burning"
  );
}

async function readArcBurns(
  options: ArcBurnIndexOptions,
): Promise<ArcBurnLog[]> {
  const arc = arcConfig(options.network);
  const chain =
    options.network === "mainnet" ? arcMainnetChain : arcTestnetChain;
  const client = createPublicClient({
    chain,
    transport: http(options.rpcUrl ?? arc.rpcUrl),
  });

  const logs = (await client.getLogs({
    address: arc.tokenMessengerV2 as Hex,
    event: depositForBurnEvent,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
  })) as Array<{
    transactionHash?: Hex | null;
    blockNumber?: bigint | null;
    args?: DepositForBurnArgs;
  }>;

  return logs.flatMap((log) => {
    if (!log.args || !log.transactionHash || log.blockNumber == null) {
      return [];
    }
    return [
      {
        transactionHash: log.transactionHash,
        args: log.args,
      },
    ];
  });
}

export async function indexArcBurns(
  store: TransferStore,
  options: ArcBurnIndexOptions,
): Promise<IndexerSummary> {
  if (options.fromBlock > options.toBlock) {
    throw new InvalidIndexerRangeError(options.fromBlock, options.toBlock);
  }

  const summary: IndexerSummary = {
    reconciled: [],
    unmatched: [],
    ambiguous: [],
    skipped: [],
    busy: [],
  };

  const candidates = (await store.list()).filter((record) =>
    isArcBurnCandidate(record, options.network),
  );
  if (candidates.length === 0) {
    return summary;
  }

  const logs = await readArcBurns(options);
  for (const record of candidates) {
    if (!record.sourceAddress) {
      summary.skipped.push(record.idempotencyKey);
      continue;
    }

    const expected = expectedBurn(record);
    const matches = logs.filter((log) =>
      matchesBurn(record, expected, log.args),
    );
    if (matches.length === 0) {
      summary.unmatched.push(record.idempotencyKey);
      continue;
    }
    if (matches.length > 1) {
      summary.ambiguous.push(record.idempotencyKey);
      continue;
    }

    const match = matches[0];
    if (!match) {
      summary.unmatched.push(record.idempotencyKey);
      continue;
    }

    try {
      const outcome: ReconcileTransferOutcome = await reconcileTransfer(store, {
        idempotencyKey: record.idempotencyKey,
        evidence: { burnTxHash: match.transactionHash },
      });
      summary.reconciled.push(outcome);
    } catch (err) {
      if (
        err instanceof TransferConflictError &&
        err.reason === "in_progress"
      ) {
        summary.busy.push(record.idempotencyKey);
        continue;
      }
      throw err;
    }
  }

  return summary;
}
