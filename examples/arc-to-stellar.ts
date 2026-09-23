/**
 * Transfers USDC from Arc to a Stellar account.
 *
 * Network defaults to mainnet, which moves real USDC and spends real Arc gas.
 * Set NETWORK=testnet to run against testnet with faucet funds instead
 * (get testnet USDC + gas from https://faucet.circle.com).
 *
 *   ARC_PRIVATE_KEY      - EVM private key funded with USDC + gas on Arc
 *   STELLAR_SECRET_KEY   - Stellar secret key (S...) funded with XLM, used only to
 *                          pay for submitting the destination `mint_and_forward` call
 *   NETWORK              - "mainnet" (default) or "testnet"
 *   STELLAR_RPC_URL      - optional Soroban RPC override (recommended on mainnet)
 */
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import {
  transfer,
  arcMainnetChain,
  arcTestnetChain,
  type Network,
  type ArcSigner,
  type StellarSigner,
} from "@asctp/parabola";

async function main() {
  const network: Network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
  const arcChain = network === "mainnet" ? arcMainnetChain : arcTestnetChain;

  const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as Hex);
  const arcSigner: ArcSigner = {
    walletClient: createWalletClient({
      account: arcAccount,
      chain: arcChain,
      transport: http(),
    }),
  };

  const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
  const destinationSigner: StellarSigner = {
    publicKey: stellarKeypair.publicKey(),
    keypair: stellarKeypair,
  };

  // Stellar recipient (G... public key), e.g. a MoneyGram cash-out partner account.
  const recipient = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

  const result = await transfer({
    from: "arc",
    to: "stellar",
    amount: "10.50",
    recipient,
    speed: "fast",
    signer: arcSigner,
    network,
    options: {
      maxFee: "0.05",
      destinationSigner,
      stellarRpcUrl: process.env.STELLAR_RPC_URL,
    },
  });

  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
