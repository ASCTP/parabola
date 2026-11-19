import { scValToNative, type rpc } from "@stellar/stellar-sdk";
import { toHex, type Hex } from "viem";
import { ARC_DOMAIN, stellarConfig } from "../constants.js";
import type { TransferRecord, TransferStore } from "../execution/contracts.js";
import { TransferConflictError } from "../execution/errors.js";
import {
  reconcileTransfer,
  type ReconcileTransferOutcome,
} from "../execution/reconciler.js";
import { toRawAmount } from "../utils/amount.js";
import { evmAddressToBytes32 } from "../utils/encoding.js";
import type { IndexerSummary, StellarBurnIndexOptions } from "./contracts.js";
import { InvalidLedgerRangeError } from "./errors.js";
import { readStellarEvents } from "./stellar-events.js";

const EVENT_NAME = "deposit_for_burn";

interface StellarBurnLog {
  transactionHash: string;
  burnToken: string;
  amount: bigint;
  depositor: string;
  mintRecipient: Hex;
  destinationDomain: number;
  hookData: Hex;
}

interface ExpectedBurn {
  burnToken: string;
  amountRaw: bigint;
  depositor: string;
  mintRecipient: Hex;
  destinationDomain: number;
  hookData: Hex;
}

function bytesToHex(value: unknown): Hex | undefined {
  if (!(value instanceof Uint8Array)) {
    return undefined;
  }
  return toHex(value);
}

function decodeBurn(event: rpc.Api.EventResponse): StellarBurnLog | undefined {
  if (
    event.type !== "contract" ||
    !event.inSuccessfulContractCall ||
    !event.txHash
  ) {
    return undefined;
  }

  const name = event.topic[0] ? scValToNative(event.topic[0]) : undefined;
  if (name !== EVENT_NAME) {
    return undefined;
  }

  const burnToken = event.topic[1] ? scValToNative(event.topic[1]) : undefined;
  const depositor = event.topic[2] ? scValToNative(event.topic[2]) : undefined;
  if (typeof burnToken !== "string" || typeof depositor !== "string") {
    return undefined;
  }

  const data = scValToNative(event.value);
  if (!Array.isArray(data)) {
    return undefined;
  }
  const [amount, mintRecipient, destinationDomain, , , , hookData] = data;
  if (typeof amount !== "bigint" || typeof destinationDomain !== "number") {
    return undefined;
  }

  const mintRecipientHex = bytesToHex(mintRecipient);
  const hookDataHex = bytesToHex(hookData);
  if (mintRecipientHex === undefined || hookDataHex === undefined) {
    return undefined;
  }

  return {
    transactionHash: event.txHash,
    burnToken,
    amount,
    depositor,
    mintRecipient: mintRecipientHex,
    destinationDomain,
    hookData: hookDataHex,
  };
}

export async function readStellarBurns(
  options: StellarBurnIndexOptions,
): Promise<StellarBurnLog[]> {
  return readStellarEvents(
    options,
    stellarConfig(options.network).tokenMessengerMinter,
    decodeBurn,
  );
}

function expectedBurn(record: TransferRecord): ExpectedBurn {
  return {
    burnToken: stellarConfig(record.network).usdc,
    amountRaw: toRawAmount(record.amount, "stellar") / 10n,
    depositor: record.sourceAddress as string,
    mintRecipient: evmAddressToBytes32(record.recipient),
    destinationDomain: ARC_DOMAIN,
    hookData: "0x",
  };
}

function matchesBurn(expected: ExpectedBurn, burn: StellarBurnLog): boolean {
  return (
    burn.burnToken === expected.burnToken &&
    burn.depositor === expected.depositor &&
    burn.mintRecipient.toLowerCase() === expected.mintRecipient.toLowerCase() &&
    burn.hookData.toLowerCase() === expected.hookData.toLowerCase() &&
    burn.amount === expected.amountRaw &&
    burn.destinationDomain === expected.destinationDomain
  );
}

function isStellarBurnCandidate(
  record: TransferRecord,
  network: StellarBurnIndexOptions["network"],
): boolean {
  return (
    record.from === "stellar" &&
    record.to === "arc" &&
    record.network === network &&
    record.phase === "burning"
  );
}

export async function indexStellarBurns(
  store: TransferStore,
  options: StellarBurnIndexOptions,
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
    isStellarBurnCandidate(record, options.network),
  );
  if (candidates.length === 0) {
    return summary;
  }

  const burns = await readStellarBurns(options);
  for (const record of candidates) {
    if (!record.sourceAddress) {
      summary.skipped.push(record.idempotencyKey);
      continue;
    }

    const expected = expectedBurn(record);
    const matches = burns.filter((burn) => matchesBurn(expected, burn));
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
