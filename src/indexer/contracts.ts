import type { rpc } from "@stellar/stellar-sdk";
import type { ReconcileTransferOutcome } from "../execution/reconciler.js";
import type { Network } from "../types.js";

export interface ArcBurnIndexOptions {
  network: Network;
  fromBlock: bigint;
  toBlock: bigint;
  rpcUrl?: string;
}

export interface StellarEventReader {
  getEvents(
    request: rpc.Api.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse>;
}

export interface StellarBurnIndexOptions {
  network: Network;
  startLedger: number;
  endLedger: number;
  rpcUrl?: string;
  reader?: StellarEventReader;
}

export interface ArcMintIndexOptions {
  network: Network;
  fromBlock: bigint;
  toBlock: bigint;
  rpcUrl?: string;
}

export interface StellarMintIndexOptions {
  network: Network;
  startLedger: number;
  endLedger: number;
  rpcUrl?: string;
  reader?: StellarEventReader;
}

export interface IndexerSummary {
  reconciled: ReconcileTransferOutcome[];
  unmatched: string[];
  ambiguous: string[];
  skipped: string[];
  busy: string[];
}
