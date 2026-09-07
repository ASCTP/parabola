/**
 * Transfers 25 USDC from a Stellar testnet account to an Arc testnet address.
 *
 * Requires two funded testnet accounts (get USDC + gas from https://faucet.circle.com):
 *   STELLAR_SECRET_KEY  - Stellar secret key (S...) funded with testnet USDC + XLM
 *   ARC_PRIVATE_KEY     - EVM private key funded with gas on Arc, used only to
 *                         pay for submitting the destination `receiveMessage` call
 */
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcTestnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

async function main() {
  const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
  const stellarSigner: StellarSigner = {
    publicKey: stellarKeypair.publicKey(),
    keypair: stellarKeypair,
  };

  const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as Hex);
  const destinationSigner: ArcSigner = {
    walletClient: createWalletClient({
      account: arcAccount,
      chain: arcTestnetChain,
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
    options: {
      destinationSigner,
    },
  });

  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
