import {
  approveUsdcOnArc,
  burnUsdcOnArcWithStellarForward,
  receiveMessageOnArc,
} from "../chains/arc.js";
import {
  approveUsdcOnStellar,
  burnUsdcOnStellar,
  checkStellarRecipientReady,
  mintAndForwardOnStellar,
} from "../chains/stellar.js";
import { ARC_DOMAIN, STELLAR_DOMAIN, stellarConfig } from "../constants.js";
import {
  fetchFastTransferFeeBps,
  getAttestation,
  pollForAttestation,
} from "../iris/poll.js";
import type {
  AttestationAdapter,
  ChainAdapter,
  FeeAdapter,
  SettlementDependencies,
} from "../kernel/contracts.js";
import type {
  ArcSigner,
  ChainId,
  Network,
  Signer,
  StellarSigner,
} from "../types.js";
import {
  encodeStellarForwardHook,
  evmAddressToBytes32,
  stellarAddressToBytes32,
} from "../utils/encoding.js";

function domainFor(chain: ChainId): number {
  return chain === "arc" ? ARC_DOMAIN : STELLAR_DOMAIN;
}

function useSandbox(network: Network): boolean {
  return network === "testnet";
}

function asArcSigner(signer: Signer): ArcSigner {
  if ("walletClient" in signer) {
    return signer;
  }
  throw new Error("Arc operation requires an ArcSigner");
}

function asStellarSigner(signer: Signer): StellarSigner {
  if ("publicKey" in signer) {
    return signer;
  }
  throw new Error("Stellar operation requires a StellarSigner");
}

const arcChainAdapter: ChainAdapter = {
  chain: "arc",

  async burn(request) {
    if (request.from !== "arc" || request.to !== "stellar") {
      throw new Error(
        `Arc adapter cannot burn from ${request.from} to ${request.to}`,
      );
    }
    const signer = asArcSigner(request.signer);
    await approveUsdcOnArc(
      signer,
      request.amountRaw,
      request.network,
      request.rpcUrl,
    );
    const hookData = encodeStellarForwardHook(request.recipient);
    const mintRecipientBytes32 = stellarAddressToBytes32(
      stellarConfig(request.network).cctpForwarder,
    );
    const transactionHash = await burnUsdcOnArcWithStellarForward({
      amountRaw: request.amountRaw,
      destinationDomain: STELLAR_DOMAIN,
      mintRecipientBytes32,
      maxFeeRaw: request.maxFeeRaw,
      minFinalityThreshold: request.minFinalityThreshold,
      hookData,
      signer,
      network: request.network,
      rpcUrl: request.rpcUrl,
    });
    return { transactionHash };
  },

  async mint(request) {
    if (request.to !== "arc") {
      throw new Error(`Arc adapter cannot mint on ${request.to}`);
    }
    const signer = asArcSigner(request.signer);
    const transactionHash = await receiveMessageOnArc({
      message: request.message,
      attestation: request.attestation,
      signer,
      network: request.network,
      rpcUrl: request.rpcUrl,
    });
    return { transactionHash };
  },
};

const stellarChainAdapter: ChainAdapter = {
  chain: "stellar",

  async burn(request) {
    if (request.from !== "stellar" || request.to !== "arc") {
      throw new Error(
        `Stellar adapter cannot burn from ${request.from} to ${request.to}`,
      );
    }
    const signer = asStellarSigner(request.signer);
    await approveUsdcOnStellar(
      request.amountRaw,
      signer,
      request.network,
      request.rpcUrl,
    );
    const transactionHash = await burnUsdcOnStellar({
      amountRaw: request.amountRaw,
      destinationDomain: ARC_DOMAIN,
      mintRecipientBytes32: evmAddressToBytes32(request.recipient),
      maxFeeRaw: request.maxFeeRaw,
      minFinalityThreshold: request.minFinalityThreshold,
      signer,
      network: request.network,
      rpcUrl: request.rpcUrl,
    });
    return { transactionHash };
  },

  async mint(request) {
    if (request.to !== "stellar") {
      throw new Error(`Stellar adapter cannot mint on ${request.to}`);
    }
    const signer = asStellarSigner(request.signer);
    const transactionHash = await mintAndForwardOnStellar({
      message: request.message,
      attestation: request.attestation,
      signer,
      network: request.network,
      rpcUrl: request.rpcUrl,
    });
    return { transactionHash };
  },

  async assertCanReceive(request) {
    const status = await checkStellarRecipientReady(
      request.recipient,
      request.network,
      request.rpcUrl,
    );
    if (!status.exists) {
      throw new Error(
        `Stellar recipient ${request.recipient} does not exist yet. It must be funded with at least the minimum XLM reserve before it can receive USDC.`,
      );
    }
    if (!status.hasTrustline) {
      throw new Error(
        `Stellar recipient ${request.recipient} exists but has no USDC trustline. It must add a trustline for the USDC asset before it can receive USDC.`,
      );
    }
  },
};

const irisAttestationAdapter: AttestationAdapter = {
  async read(request) {
    const message = await getAttestation({
      sourceDomain: domainFor(request.source),
      transactionHash: request.transactionHash,
      useSandbox: useSandbox(request.network),
    });
    return {
      attestation: message.attestation,
      message: message.message,
      status: message.status,
    };
  },

  async poll(request) {
    const message = await pollForAttestation({
      sourceDomain: domainFor(request.source),
      transactionHash: request.transactionHash,
      useSandbox: useSandbox(request.network),
      pollInterval: request.pollInterval,
      pollTimeout: request.pollTimeout,
    });
    return {
      attestation: message.attestation,
      message: message.message,
      status: message.status,
    };
  },
};

const irisFeeAdapter: FeeAdapter = {
  fastTransferFeeBps(request) {
    return fetchFastTransferFeeBps(
      domainFor(request.from),
      domainFor(request.to),
      useSandbox(request.network),
    );
  },
};

export const defaultSettlementDependencies: SettlementDependencies = {
  chains: {
    arc: arcChainAdapter,
    stellar: stellarChainAdapter,
  },
  attestations: irisAttestationAdapter,
  fees: irisFeeAdapter,
};
