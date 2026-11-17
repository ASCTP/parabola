import { createPublicClient, http, type Hex } from "viem";
import { arcMainnetChain, arcTestnetChain } from "../chains/arc.js";
import {
  STELLAR_DOMAIN,
  arcConfig,
  stellarConfig,
} from "../constants.js";
import type { TransferRecord, TransferStore } from "../execution/contracts.js";
import { TransferConflictError } from "../execution/errors.js";
import {
  reconcileTransfer,
  type ReconcileTransferOutcome,
} from "../execution/reconciler.js";
import { toRawAmount } from "../utils/amount.js";
import {
  evmAddressToBytes32,
  stellarAddressToBytes32,
} from "../utils/encoding.js";
import { decodeCctpBurnBody } from "../utils/message.js";
import type {
  ArcMintIndexOptions,
  IndexerSummary,
} from "./contracts.js";
import { InvalidIndexerRangeError } from "./errors.js";

const messageReceivedEvent = {
  type: "event",
  name: "MessageReceived",
  inputs: [
    { name: "caller", type: "address", indexed: true },
    { name: "sourceDomain", type: "uint32", indexed: false },
    { name: "nonce", type: "bytes32", indexed: true },
    { name: "sender", type: "bytes32", indexed: false },
    { name: "finalityThresholdExecuted", type: "uint32", indexed: true },
    { name: "messageBody", type: "bytes", indexed: false },
  ],
} as const;

interface MessageReceivedArgs {
  caller: Hex;
  sourceDomain: number;
  nonce: Hex;
  sender: Hex;
  finalityThresholdExecuted: number;
  messageBody: Hex;
}

interface ArcMintLog {
  transactionHash: Hex;
  args: MessageReceivedArgs;
}

interface ExpectedMint {
  sender: Hex;
  burnToken: Hex;
  mintRecipient: Hex;
  amountRaw: bigint;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function expectedMint(record: TransferRecord): ExpectedMint {
  const stellar = stellarConfig(record.network);
  return {
    sender: stellarAddressToBytes32(stellar.tokenMessengerMinter),
    burnToken: stellarAddressToBytes32(stellar.usdc),
    mintRecipient: evmAddressToBytes32(record.recipient),
    amountRaw: toRawAmount(record.amount, "stellar") / 10n,
  };
}

function matchesMint(
  expected: ExpectedMint,
  args: MessageReceivedArgs,
): boolean {
  if (
    args.sourceDomain !== STELLAR_DOMAIN ||
    !sameHex(args.sender, expected.sender)
  ) {
    return false;
  }

  let body;
  try {
    body = decodeCctpBurnBody(args.messageBody);
  } catch {
    return false;
  }

  return (
    sameHex(body.burnToken, expected.burnToken) &&
    sameHex(body.mintRecipient, expected.mintRecipient) &&
    body.amountRaw === expected.amountRaw &&
    body.hookData === null
  );
}

function isArcMintCandidate(
  record: TransferRecord,
  network: ArcMintIndexOptions["network"],
): boolean {
  return (
    record.from === "stellar" &&
    record.to === "arc" &&
    record.network === network &&
    record.phase !== "failed" &&
    record.burnTxHash !== undefined &&
    record.mintTxHash === undefined
  );
}

async function readArcMints(
  options: ArcMintIndexOptions,
): Promise<ArcMintLog[]> {
  const arc = arcConfig(options.network);
  const chain =
    options.network === "mainnet" ? arcMainnetChain : arcTestnetChain;
  const client = createPublicClient({
    chain,
    transport: http(options.rpcUrl ?? arc.rpcUrl),
  });

  const logs = (await client.getLogs({
    address: arc.messageTransmitterV2 as Hex,
    event: messageReceivedEvent,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
  })) as Array<{
    transactionHash?: Hex | null;
    blockNumber?: bigint | null;
    args?: MessageReceivedArgs;
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

export async function indexArcMints(
  store: TransferStore,
  options: ArcMintIndexOptions,
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
    isArcMintCandidate(record, options.network),
  );
  if (candidates.length === 0) {
    return summary;
  }

  const logs = await readArcMints(options);
  for (const record of candidates) {
    const expected = expectedMint(record);
    const matches = logs.filter((log) => matchesMint(expected, log.args));
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
        evidence: { mintTxHash: match.transactionHash },
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
