# wallet-transfer-demo

A minimal browser app demonstrating Parabola's non-custodial integration pattern: a visitor
connects their own MetaMask (Arc) and Freighter (Stellar) wallets and triggers a real transfer.
Nothing here holds a private key; every signature happens in the wallet extension.

This is also meant to be copied. `src/lib/` and `src/hooks/` are written to be liftable into
your own app with minimal changes. See [`../../INTEGRATION.md`](../../INTEGRATION.md) for the
two integration patterns this app illustrates (this one, plus the backend-held-key alternative).

## Live demo

[parabola-wallet-transfer-demo.vercel.app](https://parabola-wallet-transfer-demo.vercel.app/)

## Prerequisites

- [MetaMask](https://metamask.io) (or another injected EVM wallet) browser extension
- [Freighter](https://freighter.app) browser extension
- Funded Arc testnet and Stellar testnet accounts, get both via [faucet.circle.com](https://faucet.circle.com)

## Running it

This app depends on `@asctp/parabola` via a pnpm workspace link (the package isn't published
yet), which means the SDK must be built once before the demo can resolve real types/JS:

```bash
# from the repo root
pnpm install
pnpm build       # builds @asctp/parabola's dist/, required before the demo will run
pnpm dev:wallet-transfer-demo     # starts this app
```

Then open the printed local URL, connect both wallets, and try a transfer. Use small amounts:
this runs against live testnet, not a simulator.

## What it demonstrates

- Building an `ArcSigner` from an injected EVM wallet (`src/lib/arcWallet.ts`): just a viem
  `WalletClient`, nothing Parabola-specific.
- Building a `StellarSigner` from Freighter (`src/lib/stellarWallet.ts`) via the
  `signTransaction` callback, rather than a raw `Keypair`.
- The single-call path: both wallets connected, `options.destinationSigner` attached, one
  `transfer()` call goes all the way to `status: "success"`.
- The two-step path (turn off "Complete the mint automatically"): `transfer()` returns
  `status: "pending"`, and a "Complete mint" button calls `completeMint()` separately once the
  destination wallet is connected.
- Honest error handling: if a transfer throws after the burn already succeeded, `transfer()`
  rethrows a `TransferError` carrying `burnTxHash`, so the error banner offers a "Complete mint"
  button instead of just telling the user to go find the hash themselves. A separate
  `SubmissionTimeoutError` covers a broadcast transaction whose confirmation timed out uncertain
  rather than failed. See `src/hooks/useTransfer.ts`, `src/components/ErrorBanner.tsx`, and
  `../../src/errors.ts`.

## Verification status

All four transfer paths (Arc→Stellar and Stellar→Arc, both standard and fast speed) have been
run end-to-end through this UI with real MetaMask and Freighter wallets against live Arc and
Stellar testnet. That live testing surfaced and fixed several real bugs beyond what typecheck and
`../../scripts/testnet-smoke.mjs` alone would have caught, including an RPC read-after-write race
in the Stellar burn path and a Vercel-specific build ordering issue; see the repo's commit history
for specifics.
