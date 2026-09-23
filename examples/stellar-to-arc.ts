/**
 * Transfers USDC from a Stellar account to an Arc address.
 *
 * Network defaults to mainnet, which moves real USDC and spends real gas.
 * Set NETWORK=testnet to run against testnet with faucet funds instead
 * (get testnet USDC + gas from https://faucet.circle.com).
 *
 *   STELLAR_SECRET_KEY  - Stellar secret key (S...) funded with USDC + XLM
 *   ARC_PRIVATE_KEY     - EVM private key funded with gas on Arc, used only to
 *                         pay for submitting the destination `receiveMessage` call
 *   NETWORK             - "mainnet" (default) or "testnet"
 *   STELLAR_RPC_URL     - optional Soroban RPC override (recommended on mainnet)
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

  const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
  const stellarSigner: StellarSigner = {
    publicKey: stellarKeypair.publicKey(),
    keypair: stellarKeypair,
  };

  const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as Hex);
  const destinationSigner: ArcSigner = {
    walletClient: createWalletClient({
      account: arcAccount,
      chain: arcChain,
      transport: http(),
    }),
  };

  // Arc recipient (0x... EVM address).
  const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const result = await transfer({
    from: "stellar",
    to: "arc",
    amount: "25.00",
    recipient,
    speed: "standard",
    signer: stellarSigner,
    network,
    options: {
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
