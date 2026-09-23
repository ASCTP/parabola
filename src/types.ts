import type { WalletClient } from "viem";
import type { Keypair } from "@stellar/stellar-sdk";

export type ChainId = "arc" | "stellar";
/** Which deployment to transact against. Defaults to "mainnet" wherever it is accepted. */
export type Network = "mainnet" | "testnet";
export type TransferSpeed = "standard" | "fast";
export type TransferMode = "standard" | "fast";
export type TransferStatus = "success" | "pending" | "failed";

/** Signs Arc (EVM) transactions. Wraps a viem WalletClient with an account attached. */
export interface ArcSigner {
  walletClient: WalletClient;
}

/** Signs Stellar transactions, either via a Keypair or a custom sign function (hardware wallets). */
export interface StellarSigner {
  publicKey: string;
  keypair?: Keypair;
  signTransaction?: (xdr: string, networkPassphrase: string) => Promise<string>;
}

export type Signer = ArcSigner | StellarSigner;

export interface TransferOptions {
  /** Max USDC fee tolerated for a fast transfer. Falls back to standard if the quoted fee exceeds this. */
  maxFee?: string;
  /** Max seconds to wait before falling back to standard transfer. */
  maxWait?: number;
  /** Milliseconds between Iris attestation polls. Default 3000. */
  pollInterval?: number;
  /** Milliseconds before polling gives up. Default 300000. */
  pollTimeout?: number;
  /**
   * Overrides the Stellar Soroban RPC URL. The mainnet default endpoint is
   * rate-limited; supply your own provider for real usage. No effect on Arc.
   */
  stellarRpcUrl?: string;
  /**
   * Signer for the destination-chain completion call (receiveMessage on Arc,
   * mint_and_forward on Stellar). This is a separate signature from `signer`
   * because completing a CCTP transfer requires paying gas natively on the
   * destination chain, which the source-chain signer cannot do. Omit this to
   * perform only the burn and attestation steps: the result comes back with
   * status "pending" and an empty mintTxHash. Call completeMint() with
   * burnTxHash and a destination-chain signer to finish it later (e.g. from a
   * backend process holding the destination key).
   */
  destinationSigner?: Signer;
}

export interface TransferParams {
  from: ChainId;
  to: ChainId;
  amount: string;
  recipient: string;
  speed: TransferSpeed;
  signer: Signer;
  /** Which deployment to transact against. Default "mainnet". */
  network?: Network;
  options?: TransferOptions;
}

export interface TransferResult {
  status: TransferStatus;
  transferMode: TransferMode;
  burnTxHash: string;
  attestationHash: string;
  mintTxHash: string;
  fee: string;
  durationMs: number;
}

export interface EstimateFeeParams {
  from: ChainId;
  to: ChainId;
  amount: string;
  speed: TransferSpeed;
  /** Which deployment to quote against. Default "mainnet". */
  network?: Network;
}

export interface FeeEstimate {
  protocolFee: string;
  estimatedDurationSeconds: number;
  transferMode: TransferMode;
}

export interface CompleteMintParams {
  /** The destination chain of the original transfer (the "to" you passed to transfer()). */
  to: ChainId;
  /** The source chain of the original transfer (the "from" you passed to transfer()). */
  from: ChainId;
  /** The burnTxHash returned by the earlier pending transfer() call. */
  burnTxHash: string;
  /** Signer native to the destination chain, used to submit receiveMessage / mint_and_forward. */
  signer: Signer;
  /** Which deployment the original transfer ran on. Default "mainnet". */
  network?: Network;
  pollInterval?: number;
  pollTimeout?: number;
  /** Overrides the Stellar Soroban RPC URL. No effect on Arc. */
  stellarRpcUrl?: string;
}

export interface CompleteMintResult {
  mintTxHash: string;
  attestationHash: string;
}
