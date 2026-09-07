/**
 * Transfers 10 USDC from Arc testnet to a Stellar testnet account.
 *
 * Requires two funded testnet accounts (get USDC + gas from https://faucet.circle.com):
 *   ARC_PRIVATE_KEY      - EVM private key funded with testnet USDC + gas on Arc
 *   STELLAR_SECRET_KEY   - Stellar secret key (S...) funded with XLM, used only to
 *                          pay for submitting the destination `mint_and_forward` call
 */
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcTestnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

async function main() {
  const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as Hex);
  const arcSigner: ArcSigner = {
    walletClient: createWalletClient({
      account: arcAccount,
      chain: arcTestnetChain,
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
    options: {
      maxFee: "0.05",
      destinationSigner,
    },
  });

  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
