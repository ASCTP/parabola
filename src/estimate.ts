import type { EstimateFeeParams, FeeEstimate, ChainId } from "./types.js";
import { ARC_DOMAIN, STELLAR_DOMAIN } from "./constants.js";
import { fetchFastTransferFeeBps } from "./iris/poll.js";
import { toRawAmount, fromRawAmount } from "./utils/amount.js";

function domainFor(chain: ChainId): number {
  return chain === "arc" ? ARC_DOMAIN : STELLAR_DOMAIN;
}

// Arc's chain finality is sub-second, but Stellar's ~5s ledger close time and
// Iris attestation overhead dominate standard-transfer duration.
const STANDARD_DURATION_SECONDS = 20;
const FAST_DURATION_SECONDS = 15;

export async function estimateFee(params: EstimateFeeParams): Promise<FeeEstimate> {
  if (params.speed === "standard") {
    return {
      protocolFee: "0",
      estimatedDurationSeconds: STANDARD_DURATION_SECONDS,
      transferMode: "standard",
    };
  }

  const network = params.network ?? "mainnet";
  const feeBps = await fetchFastTransferFeeBps(
    domainFor(params.from),
    domainFor(params.to),
    network === "testnet",
  );

  const amountRaw = toRawAmount(params.amount, params.from);
  const feeRaw = (amountRaw * BigInt(feeBps)) / 10_000n;

  return {
    protocolFee: fromRawAmount(feeRaw, params.from),
    estimatedDurationSeconds: FAST_DURATION_SECONDS,
    transferMode: "fast",
  };
}
