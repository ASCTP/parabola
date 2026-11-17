import type { TransferStore } from "./execution/contracts.js";
import {
  executeTransfer,
  type ExecuteTransferOptions,
  type ExecuteTransferOutcome,
} from "./execution/executor.js";
import {
  reconcileTransfer,
  type ReconcileTransferOptions,
  type ReconcileTransferOutcome,
} from "./execution/reconciler.js";
import { indexArcBurns } from "./indexer/arc-burns.js";
import { indexArcMints } from "./indexer/arc-mints.js";
import {
  syncArcBurns,
  syncArcMints,
  type ArcSyncOptions,
  type ArcSyncResult,
} from "./indexer/arc-sync.js";
import type {
  ArcBurnIndexOptions,
  ArcMintIndexOptions,
  IndexerSummary,
  StellarBurnIndexOptions,
  StellarMintIndexOptions,
} from "./indexer/contracts.js";
import { indexStellarBurns } from "./indexer/stellar-burns.js";
import { indexStellarMints } from "./indexer/stellar-mints.js";
import {
  syncStellarBurns,
  syncStellarMints,
  type StellarSyncOptions,
  type StellarSyncResult,
} from "./indexer/stellar-sync.js";
import type { SettlementKernel } from "./kernel/contracts.js";
import { createSettlementKernel } from "./kernel/kernel.js";
import { defaultSettlementDependencies } from "./providers/default.js";
import type {
  ResolveBurnParams,
  ResolvedBurn,
  TransferParams,
} from "./types.js";
export {
  createIndexerWorker,
  type ArcWorkerStreamOptions,
  type IndexerTaskName,
  type IndexerWorker,
  type IndexerWorkerOptions,
  type StellarWorkerStreamOptions,
  type WorkerCycleResult,
  type WorkerTaskResult,
} from "./worker.js";

export interface SettlementRuntimeOptions {
  kernel?: SettlementKernel;
}

export interface SettlementRuntime {
  execute(
    params: TransferParams,
    options: ExecuteTransferOptions,
  ): Promise<ExecuteTransferOutcome>;
  reconcile(
    options: ReconcileTransferOptions,
  ): Promise<ReconcileTransferOutcome>;
  resolveBurn(params: ResolveBurnParams): Promise<ResolvedBurn>;
  indexArcBurns(options: ArcBurnIndexOptions): Promise<IndexerSummary>;
  indexArcMints(options: ArcMintIndexOptions): Promise<IndexerSummary>;
  indexStellarBurns(
    options: StellarBurnIndexOptions,
  ): Promise<IndexerSummary>;
  indexStellarMints(
    options: StellarMintIndexOptions,
  ): Promise<IndexerSummary>;
  syncArcBurns(options: ArcSyncOptions): Promise<ArcSyncResult>;
  syncArcMints(options: ArcSyncOptions): Promise<ArcSyncResult>;
  syncStellarBurns(options: StellarSyncOptions): Promise<StellarSyncResult>;
  syncStellarMints(options: StellarSyncOptions): Promise<StellarSyncResult>;
}

export function createSettlementRuntime(
  store: TransferStore,
  options: SettlementRuntimeOptions = {},
): SettlementRuntime {
  const kernel =
    options.kernel ??
    createSettlementKernel(defaultSettlementDependencies);

  return {
    execute(params, executeOptions) {
      return executeTransfer(kernel, store, params, executeOptions);
    },
    reconcile(reconcileOptions) {
      return reconcileTransfer(store, reconcileOptions);
    },
    resolveBurn(params) {
      return kernel.resolveBurn(params);
    },
    indexArcBurns(indexOptions) {
      return indexArcBurns(store, indexOptions);
    },
    indexArcMints(indexOptions) {
      return indexArcMints(store, indexOptions);
    },
    indexStellarBurns(indexOptions) {
      return indexStellarBurns(store, indexOptions);
    },
    indexStellarMints(indexOptions) {
      return indexStellarMints(store, indexOptions);
    },
    syncArcBurns(syncOptions) {
      return syncArcBurns(store, syncOptions);
    },
    syncArcMints(syncOptions) {
      return syncArcMints(store, syncOptions);
    },
    syncStellarBurns(syncOptions) {
      return syncStellarBurns(store, syncOptions);
    },
    syncStellarMints(syncOptions) {
      return syncStellarMints(store, syncOptions);
    },
  };
}
