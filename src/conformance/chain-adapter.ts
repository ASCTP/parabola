import type {
  BurnReceipt,
  ChainAdapter,
  MintReceipt,
  SettlementDependencies,
} from "../kernel/contracts.js";
import type { ChainId, Network, Signer } from "../types.js";

export class ConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string) {
    super(`${check}: ${message}`);
    this.name = "ConformanceError";
    this.check = check;
  }
}

function otherChain(chain: ChainId): ChainId {
  return chain === "arc" ? "stellar" : "arc";
}

function assertReceiptHash(
  check: string,
  label: string,
  receipt: unknown,
): string {
  if (typeof receipt !== "object" || receipt === null) {
    throw new ConformanceError(
      check,
      `${label} returned a non-object receipt`,
    );
  }
  const transactionHash = (receipt as { transactionHash?: unknown })
    .transactionHash;
  if (
    typeof transactionHash !== "string" ||
    transactionHash.trim() === ""
  ) {
    throw new ConformanceError(
      check,
      `${label} returned an empty transaction hash`,
    );
  }
  return transactionHash;
}

export function assertChainAdapterConforms(adapter: ChainAdapter): void {
  if (typeof adapter !== "object" || adapter === null) {
    throw new ConformanceError(
      "chain",
      "adapter must be an object",
    );
  }
  if (adapter.chain !== "arc" && adapter.chain !== "stellar") {
    throw new ConformanceError(
      "chain",
      `expected "arc" or "stellar", received ${String(adapter.chain)}`,
    );
  }
  if (typeof adapter.burn !== "function") {
    throw new ConformanceError("burn", "burn must be a function");
  }
  if (typeof adapter.mint !== "function") {
    throw new ConformanceError("mint", "mint must be a function");
  }
  if (
    adapter.assertCanReceive !== undefined &&
    typeof adapter.assertCanReceive !== "function"
  ) {
    throw new ConformanceError(
      "assertCanReceive",
      "assertCanReceive must be a function when present",
    );
  }
}

export interface ChainAdapterProbeOptions {
  network: Network;
  amountRaw: bigint;
  recipient: string;
  signer: Signer;
  message: `0x${string}`;
  attestation: `0x${string}`;
  maxFeeRaw?: bigint;
  minFinalityThreshold?: number;
  rpcUrl?: string;
  checkRecipient?: boolean;
}

export interface ChainAdapterProbeResult {
  burn: BurnReceipt;
  mint: MintReceipt;
  recipientCheck: "passed" | "skipped";
}

export async function probeChainAdapter(
  adapter: ChainAdapter,
  options: ChainAdapterProbeOptions,
): Promise<ChainAdapterProbeResult> {
  assertChainAdapterConforms(adapter);

  const from = adapter.chain;
  const to = otherChain(from);

  let recipientCheck: "passed" | "skipped" = "skipped";
  if (options.checkRecipient !== false && adapter.assertCanReceive) {
    await adapter.assertCanReceive({
      recipient: options.recipient,
      network: options.network,
      rpcUrl: options.rpcUrl,
    });
    recipientCheck = "passed";
  }

  const burn = await adapter.burn({
    from,
    to,
    network: options.network,
    amountRaw: options.amountRaw,
    recipient: options.recipient,
    maxFeeRaw: options.maxFeeRaw ?? 0n,
    minFinalityThreshold: options.minFinalityThreshold ?? 2000,
    signer: options.signer,
    rpcUrl: options.rpcUrl,
  });
  assertReceiptHash("burn", "burn", burn);

  const mint = await adapter.mint({
    from: to,
    to: from,
    network: options.network,
    message: options.message,
    attestation: options.attestation,
    signer: options.signer,
    rpcUrl: options.rpcUrl,
  });
  assertReceiptHash("mint", "mint", mint);

  return { burn, mint, recipientCheck };
}

export function assertSettlementDependenciesConform(
  dependencies: SettlementDependencies,
): void {
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new ConformanceError(
      "dependencies",
      "dependencies must be an object",
    );
  }

  const chains = dependencies.chains as
    | Partial<Record<ChainId, ChainAdapter>>
    | undefined;
  for (const chain of ["arc", "stellar"] as const) {
    const adapter = chains?.[chain];
    if (!adapter) {
      throw new ConformanceError(
        "dependencies.chains",
        `missing ${chain} adapter`,
      );
    }
    try {
      assertChainAdapterConforms(adapter);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new ConformanceError(
        "dependencies.chains",
        `${chain} adapter failed: ${message}`,
      );
    }
    if (adapter.chain !== chain) {
      throw new ConformanceError(
        "dependencies.chains",
        `${chain} slot contains a ${adapter.chain} adapter`,
      );
    }
  }

  const attestations = dependencies.attestations as
    | { read?: unknown; poll?: unknown }
    | undefined;
  if (typeof attestations?.read !== "function") {
    throw new ConformanceError(
      "dependencies.attestations",
      "read must be a function",
    );
  }
  if (typeof attestations.poll !== "function") {
    throw new ConformanceError(
      "dependencies.attestations",
      "poll must be a function",
    );
  }

  const fees = dependencies.fees as
    | { fastTransferFeeBps?: unknown }
    | undefined;
  if (typeof fees?.fastTransferFeeBps !== "function") {
    throw new ConformanceError(
      "dependencies.fees",
      "fastTransferFeeBps must be a function",
    );
  }
}
