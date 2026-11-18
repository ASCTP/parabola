import type { ChainAdapter } from "../../src/kernel/contracts.js";
import type { ArcSigner, StellarSigner } from "../../src/types.js";

export const ARC_SIGNER: ArcSigner = {
  walletClient: {} as ArcSigner["walletClient"],
};

export const STELLAR_SIGNER: StellarSigner = {
  publicKey: "GABCD",
  signTransaction: async () => "",
};

export function fakeChainAdapter(
  chain: "arc" | "stellar",
): ChainAdapter {
  return {
    chain,
    async burn(request) {
      return { transactionHash: `burn-${request.from}-${request.to}` };
    },
    async mint(request) {
      return { transactionHash: `mint-${request.from}-${request.to}` };
    },
    async assertCanReceive() {},
  };
}
