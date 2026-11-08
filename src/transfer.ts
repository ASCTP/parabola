import { createSettlementKernel } from "./kernel/kernel.js";
import { defaultSettlementDependencies } from "./providers/default.js";
import type {
  CompleteMintParams,
  CompleteMintResult,
  ResolveBurnParams,
  ResolvedBurn,
  TransferParams,
  TransferResult,
} from "./types.js";

const kernel = createSettlementKernel(defaultSettlementDependencies);

export function transfer(params: TransferParams): Promise<TransferResult> {
  return kernel.transfer(params);
}

/**
 * Reads back what a burn has already committed to: the destination domain, the amount, and
 * for a Stellar-bound burn the account the mint will actually pay.
 *
 * This matters most for a service completing someone else's transfer. The burn message is
 * the only authoritative statement of where the minted USDC goes, and the forward hook
 * inside it is the only place a Stellar recipient is recorded, so a caller that has not
 * produced the burn itself has no other way to learn the destination.
 *
 * Resolves as soon as Iris has indexed the burn, which is before Circle signs it, so the
 * message can be read while the attestation is still pending. `attestation` in the result
 * is null in that case.
 */
export function resolveBurn(params: ResolveBurnParams): Promise<ResolvedBurn> {
  return kernel.resolveBurn(params);
}

/**
 * Completes a transfer that was left "pending" because transfer() was called
 * without options.destinationSigner, or one whose burn was produced by another system
 * entirely. Re-polls Iris for the burn's attestation (in case it wasn't available yet)
 * and submits the destination-chain mint: receiveMessage on Arc, or mint_and_forward on
 * Stellar's CctpForwarder.
 *
 * For a Stellar destination the mint pays whichever account the burn message's forward
 * hook names, so that account is read out of the message and checked before anything is
 * submitted. transfer() performs the same check up front; doing it here too means the
 * guarantee holds for a caller that never ran transfer() at all.
 */
export function completeMint(
  params: CompleteMintParams,
): Promise<CompleteMintResult> {
  return kernel.completeMint(params);
}
