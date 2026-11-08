import type {
  ChainId,
  CompleteMintParams,
  CompleteMintResult,
  Network,
  ResolveBurnParams,
  ResolvedBurn,
  Signer,
  TransferParams,
  TransferResult,
} from "../types.js";

export interface BurnRequest {
  from: ChainId;
  to: ChainId;
  network: Network;
  amountRaw: bigint;
  recipient: string;
  maxFeeRaw: bigint;
  minFinalityThreshold: number;
  signer: Signer;
  rpcUrl?: string;
}

export interface BurnReceipt {
  transactionHash: string;
}

export interface MintRequest {
  from: ChainId;
  to: ChainId;
  network: Network;
  message: `0x${string}`;
  attestation: `0x${string}`;
  signer: Signer;
  rpcUrl?: string;
}

export interface MintReceipt {
  transactionHash: string;
}

export interface RecipientCheckRequest {
  recipient: string;
  network: Network;
  rpcUrl?: string;
}

export interface ChainAdapter {
  readonly chain: ChainId;
  burn(request: BurnRequest): Promise<BurnReceipt>;
  mint(request: MintRequest): Promise<MintReceipt>;
  assertCanReceive?(request: RecipientCheckRequest): Promise<void>;
}

export interface AttestationRecord {
  attestation: string | null;
  message: string | null;
  status: "pending_confirmations" | "complete";
}

export interface AttestationReadRequest {
  source: ChainId;
  transactionHash: string;
  network: Network;
}

export interface AttestationPollRequest extends AttestationReadRequest {
  pollInterval?: number;
  pollTimeout?: number;
}

export interface AttestationAdapter {
  read(request: AttestationReadRequest): Promise<AttestationRecord>;
  poll(request: AttestationPollRequest): Promise<AttestationRecord>;
}

export interface FeeRequest {
  from: ChainId;
  to: ChainId;
  network: Network;
}

export interface FeeAdapter {
  fastTransferFeeBps(request: FeeRequest): Promise<number>;
}

export interface SettlementDependencies {
  chains: Record<ChainId, ChainAdapter>;
  attestations: AttestationAdapter;
  fees: FeeAdapter;
}

export interface SettlementKernel {
  transfer(params: TransferParams): Promise<TransferResult>;
  completeMint(params: CompleteMintParams): Promise<CompleteMintResult>;
  resolveBurn(params: ResolveBurnParams): Promise<ResolvedBurn>;
}
