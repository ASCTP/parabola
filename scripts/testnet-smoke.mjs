#!/usr/bin/env node
// End-to-end smoke test against live Arc and Stellar testnets. Unlike the
// mocked unit tests in tests/, this exercises the real depositForBurn /
// receiveMessage / mint_and_forward calls and waits on real Iris attestations.
//
// Requires funded testnet keys (see .env.example, fund via
// https://faucet.circle.com) and a built package (`pnpm build` first), since
// this imports from dist/, not src/, so it also catches bundling regressions
// that unit tests against src/ can't see.
//
// Not run in the default CI workflow: it needs funded secrets and takes
// 20s-5min per transfer depending on speed. Run manually, or wire into a
// workflow_dispatch job once ARC_PRIVATE_KEY / STELLAR_SECRET_KEY exist as
// repo secrets.

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcMainnetChain, arcTestnetChain } from "../dist/index.js";

const ARC_PRIVATE_KEY = process.env.ARC_PRIVATE_KEY;
const STELLAR_SECRET_KEY = process.env.STELLAR_SECRET_KEY;

// Defaults to testnet. Set NETWORK=mainnet to smoke against mainnet, which
// moves real USDC and spends real Arc gas on every case below.
const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;

if (!ARC_PRIVATE_KEY || !STELLAR_SECRET_KEY) {
  console.error(
    "Missing ARC_PRIVATE_KEY and/or STELLAR_SECRET_KEY.\n" +
      "Fund testnet accounts at https://faucet.circle.com, copy .env.example to .env, " +
      "fill in both keys, then export them in your shell (or, on Node 20.6+, run with " +
      "`node --env-file=.env scripts/testnet-smoke.mjs`) before re-running `pnpm smoke`.",
  );
  process.exit(1);
}

const arcChain = NETWORK === "mainnet" ? arcMainnetChain : arcTestnetChain;
const arcAccount = privateKeyToAccount(ARC_PRIVATE_KEY);
const arcSigner = {
  walletClient: createWalletClient({ account: arcAccount, chain: arcChain, transport: http() }),
};

const stellarKeypair = Keypair.fromSecret(STELLAR_SECRET_KEY);
const stellarSigner = { publicKey: stellarKeypair.publicKey(), keypair: stellarKeypair };

const SMOKE_AMOUNT = "1.00";
let failures = 0;

console.log(`Running smoke cases against ${NETWORK}.`);
if (NETWORK === "mainnet") {
  console.log("WARNING: mainnet moves real USDC and spends real Arc gas.");
}

async function runCase(name, params) {
  console.log(`\n--- ${name} ---`);
  const start = Date.now();
  try {
    const result = await transfer(params);
    console.log(JSON.stringify(result, null, 2));

    if (result.status !== "success") {
      throw new Error(`expected status "success", got "${result.status}"`);
    }
    if (!result.mintTxHash) {
      throw new Error("expected a non-empty mintTxHash");
    }
    console.log(`PASS ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}:`, error instanceof Error ? error.message : error);
  }
}

await runCase("arc -> stellar (standard)", {
  from: "arc",
  to: "stellar",
  amount: SMOKE_AMOUNT,
  recipient: stellarKeypair.publicKey(),
  speed: "standard",
  signer: arcSigner,
  network: NETWORK,
  options: { destinationSigner: stellarSigner, stellarRpcUrl: STELLAR_RPC_URL },
});

await runCase("stellar -> arc (standard)", {
  from: "stellar",
  to: "arc",
  amount: SMOKE_AMOUNT,
  recipient: arcAccount.address,
  speed: "standard",
  signer: stellarSigner,
  network: NETWORK,
  options: { destinationSigner: arcSigner, stellarRpcUrl: STELLAR_RPC_URL },
});

if (failures > 0) {
  console.error(`\n${failures} smoke test case(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke test cases passed.");
