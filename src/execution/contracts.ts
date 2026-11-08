import type { TransferPhase } from "../kernel/state.js";
import type { ChainId, Network, TransferResult } from "../types.js";

export interface TransferRecord {
  idempotencyKey: string;
  phase: TransferPhase;
  from: ChainId;
  to: ChainId;
  network: Network;
  amount: string;
  recipient: string;
  burnTxHash?: string;
  attestationHash?: string;
  mintTxHash?: string;
  error?: string;
  result?: TransferResult;
  createdAt: number;
  updatedAt: number;
}

export interface TransferStore {
  get(idempotencyKey: string): Promise<TransferRecord | undefined>;
  create(record: TransferRecord): Promise<boolean>;
  put(record: TransferRecord): Promise<void>;
  delete(idempotencyKey: string): Promise<void>;
}
