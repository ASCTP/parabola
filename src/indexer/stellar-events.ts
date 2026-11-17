import { rpc } from "@stellar/stellar-sdk";
import { stellarConfig } from "../constants.js";
import type { Network } from "../types.js";
import type { StellarEventReader } from "./contracts.js";
import { InvalidLedgerRangeError } from "./errors.js";

const PAGE_LIMIT = 200;
const MAX_PAGES = 1_000;

export interface StellarEventRange {
  network: Network;
  startLedger: number;
  endLedger: number;
  rpcUrl?: string;
  reader?: StellarEventReader;
}

export async function readStellarEvents<T>(
  options: StellarEventRange,
  contractId: string,
  decode: (event: rpc.Api.EventResponse) => T | undefined,
): Promise<T[]> {
  if (options.startLedger > options.endLedger) {
    throw new InvalidLedgerRangeError(options.startLedger, options.endLedger);
  }

  const reader =
    options.reader ??
    new rpc.Server(
      options.rpcUrl ?? stellarConfig(options.network).sorobanRpcUrl,
    );
  const filters = [
    {
      type: "contract" as const,
      contractIds: [contractId],
    },
  ];

  const decoded: T[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = cursor
      ? await reader.getEvents({
          filters,
          cursor,
          limit: PAGE_LIMIT,
        })
      : await reader.getEvents({
          filters,
          startLedger: options.startLedger,
          endLedger: options.endLedger,
          limit: PAGE_LIMIT,
        });

    for (const event of response.events) {
      if (
        event.ledger < options.startLedger ||
        event.ledger > options.endLedger
      ) {
        continue;
      }
      const value = decode(event);
      if (value !== undefined) {
        decoded.push(value);
      }
    }

    if (response.events.some((event) => event.ledger > options.endLedger)) {
      break;
    }
    if (response.events.length < PAGE_LIMIT) {
      break;
    }

    const nextCursor = response.cursor;
    if (!nextCursor || nextCursor === previousCursor) {
      break;
    }
    previousCursor = nextCursor;
    cursor = nextCursor;
  }

  return decoded;
}
