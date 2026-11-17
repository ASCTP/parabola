import { scValToNative, type rpc } from "@stellar/stellar-sdk";
import { stellarConfig } from "../constants.js";
import type { TransferRecord, TransferStore } from "../execution/contracts.js";
import { TransferConflictError } from "../execution/errors.js";
import {
  reconcileTransfer,
  type ReconcileTransferOutcome,
} from "../execution/reconciler.js";
import { toRawAmount } from "../utils/amount.js";
import type {
  IndexerSummary,
  StellarMintIndexOptions,
} from "./contracts.js";
import { InvalidLedgerRangeError } from "./errors.js";
import { readStellarEvents } from "./stellar-events.js";

const EVENT_NAME = "mint_and_forward";

interface StellarMintLog {
  transactionHash: string;
  forwardRecipient: string;
  token: string;
  amount: bigint;
}

function decodeMint(
  event: rpc.Api.EventResponse,
): StellarMintLog | undefined {
  if (
    event.type !== "contract" ||
    !event.inSuccessfulContractCall ||
    !event.txHash
  ) {
    return undefined;
  }

  const name = event.topic[0]
    ? scValToNative(event.topic[0])
    : undefined;
  if (name !== EVENT_NAME) {
    return undefined;
  }

  const data = scValToNative(event.value);
  if (!Array.isArray(data)) {
    return undefined;
  }
  const [forwardRecipient, token, amount] = data;
  if (
    typeof forwardRecipient !== "string" ||
    typeof token !== "string" ||
    typeof amount !== "bigint"
  ) {
    return undefined;
  }

  return {
    transactionHash: event.txHash,
    forwardRecipient,
    token,
    amount,
  };
}

export async function readStellarMints(
  options: StellarMintIndexOptions,
): Promise<StellarMintLog[]> {
  return readStellarEvents(
    options,
    stellarConfig(options.network).cctpForwarder,
    decodeMint,
  );
}

function matchesMint(
  record: TransferRecord,
  mint: StellarMintLog,
): boolean {
  return (
    mint.forwardRecipient === record.recipient &&
    mint.token === stellarConfig(record.network).usdc &&
    mint.amount === toRawAmount(record.amount, "stellar")
  );
}

function isStellarMintCandidate(
  record: TransferRecord,
  network: StellarMintIndexOptions["network"],
): boolean {
  return (
    record.from === "arc" &&
    record.to === "stellar" &&
    record.network === network &&
    record.phase !== "failed" &&
    record.burnTxHash !== undefined &&
    record.mintTxHash === undefined
  );
}

export async function indexStellarMints(
  store: TransferStore,
  options: StellarMintIndexOptions,
): Promise<IndexerSummary> {
  if (options.startLedger > options.endLedger) {
    throw new InvalidLedgerRangeError(options.startLedger, options.endLedger);
  }

  const summary: IndexerSummary = {
    reconciled: [],
    unmatched: [],
    ambiguous: [],
    skipped: [],
    busy: [],
  };

  const candidates = (await store.list()).filter((record) =>
    isStellarMintCandidate(record, options.network),
  );
  if (candidates.length === 0) {
    return summary;
  }

  const mints = await readStellarMints(options);
  for (const record of candidates) {
    const matches = mints.filter((mint) => matchesMint(record, mint));
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
