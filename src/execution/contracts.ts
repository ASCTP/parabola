import type { TransferPhase } from "../kernel/state.js";
import type {
  ChainId,
  Network,
  TransferMode,
  TransferResult,
} from "../types.js";

export interface TransferRecord {
  idempotencyKey: string;
  phase: TransferPhase;
  from: ChainId;
  to: ChainId;
  network: Network;
  amount: string;
  recipient: string;
  /** Address that submits the source-chain burn, when known. Used for reconciliation. */
  sourceAddress?: string;
  transferMode?: TransferMode;
  fee?: string;
  burnTxHash?: string;
  attestationHash?: string;
  mintTxHash?: string;
  error?: string;
  result?: TransferResult;
  createdAt: number;
  updatedAt: number;
}

export interface TransferLease {
  owner: string;
  expiresAt: number;
}

export type TransferClaim =
  | { status: "claimed"; record?: TransferRecord }
  | { status: "busy"; record?: TransferRecord };

export interface TransferStore {
  get(idempotencyKey: string): Promise<TransferRecord | undefined>;
  list(): Promise<TransferRecord[]>;
  create(record: TransferRecord): Promise<boolean>;
  put(record: TransferRecord): Promise<void>;
  delete(idempotencyKey: string): Promise<void>;
  claim(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<TransferClaim>;
  renew(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean>;
  release(idempotencyKey: string, owner: string): Promise<void>;
}
