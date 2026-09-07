# Integrating Parabola

## Who this guide is for

The [README](README.md) covers installation and one-off scripts: import `transfer()`, build a
signer, call it, done. This guide is different: it's for wiring Parabola into a persistent
application, backend service or browser app, where the concerns are different: where do keys
live, what happens when a call fails partway through, and how do you resume a transfer that
didn't finish. If you haven't read the README yet, start there; this guide assumes you have.

## Two integration patterns

### Pattern A: backend-held keys

**When to use:** your service already custodies a hot wallet key server-side for one or both
chains, e.g. an operational treasury wallet, a relayer, anything where the key already lives in
your infrastructure rather than a user's wallet.

**Shape:** build a signer once from an env-stored private key, call `transfer()` from an API
route or background job. This is exactly what [`examples/arc-to-stellar.ts`](examples/arc-to-stellar.ts)
and [`examples/stellar-to-arc.ts`](examples/stellar-to-arc.ts) already show; read those as the
base pattern for this approach.

### Pattern B: non-custodial browser wallet (recommended for user-facing apps)

**When to use:** end users connect their own wallets and your app never touches a private key.

**Shape:**

- `ArcSigner` just wraps a viem `WalletClient`. Build one from an injected wallet with
  `createWalletClient({ account, chain: arcTestnetChain, transport: custom(window.ethereum) })`
  and you have a valid `ArcSigner`. Nothing Parabola-specific about it.
- `StellarSigner` accepts a `signTransaction` callback instead of a raw `Keypair` for exactly
  this case. Freighter's own `signTransaction(xdr, opts)` resolves to
  `{ signedTxXdr: string; signerAddress: string; error?: FreighterApiError }` (note it's an
  **object**, not a plain string, and it never throws; check `.error` on every call). Your
  callback just needs to unwrap `.signedTxXdr`.

**Reference:** [`demos/wallet-transfer-demo/`](demos/wallet-transfer-demo) is the full working
example of this pattern, specifically
[`src/lib/arcWallet.ts`](demos/wallet-transfer-demo/src/lib/arcWallet.ts) and
[`src/lib/stellarWallet.ts`](demos/wallet-transfer-demo/src/lib/stellarWallet.ts).

## Known rough edge: burnTxHash is lost if attestation polling times out

`transfer()` burns on the source chain, then polls Circle's Iris service for an attestation. If
that polling step times out (`pollTimeout`, default 5 minutes), `transfer()` throws, and the
`burnTxHash` from the already-succeeded burn is never returned to you. The thrown error carries
no reference back to it. This means: a timeout error does not mean your transfer failed to
start, it can mean funds already left the source chain and you have no built-in way to look up
which transaction did it.

**Practical mitigation:** capture the burn transaction hash yourself, independent of Parabola's
return value, e.g. watch the wallet/provider's own pending-transaction event, or read it back
from the signer before `transfer()` resolves. That gives you a fallback lookup path if
`transfer()` rejects.

**How the demo surfaces this:**
[`src/components/ErrorBanner.tsx`](demos/wallet-transfer-demo/src/components/ErrorBanner.tsx)
never claims "nothing happened" on a thrown error; copy that UX pattern rather than showing a
generic failure message.

## Recovering from a "pending" result: destinationSigner and completeMint

This is a different, sanctioned recovery path from the one above: use it when you deliberately
didn't attach `options.destinationSigner` (for example, your backend only holds the source
chain's key at call time). `transfer()` performs the burn and attestation polling, then returns
`status: "pending"` with a populated `burnTxHash` and an empty `mintTxHash`. `completeMint()`
finishes it later, given that `burnTxHash`.

**Persistence requirement this guide adds:** if your backend could restart between the initial
`transfer()` call and calling `completeMint()`, persist `{ from, to, burnTxHash }` to durable
storage before you return from the first call. `CompleteMintParams` requires `burnTxHash` as
input, and unlike the timeout case above, this is a hash Parabola *does* hand back to you, so
don't let it evaporate in memory.

**Reference:**
[`src/components/TransferStatus.tsx`](demos/wallet-transfer-demo/src/components/TransferStatus.tsx)'s
"Complete mint" button is the interactive version of this recovery path.

## Running the demo app locally

```bash
pnpm install
pnpm build      # builds @asctp/parabola: required first, see demos/wallet-transfer-demo/README.md
pnpm dev:wallet-transfer-demo
```

Prerequisites: MetaMask and Freighter browser extensions, and funded Arc + Stellar testnet
accounts via [faucet.circle.com](https://faucet.circle.com). Both integration patterns above are
reachable in the same UI: check or uncheck "Complete the mint automatically" to switch between
them.

## Choosing a pattern for your app

No user-key custody at all, ever -> Pattern B. Already have an operational wallet funded and
ready to sign -> Pattern A is simpler, one fewer moving part. Nothing stops a single application
from using both for different flows (e.g. Pattern A for automated payouts, Pattern B for
user-initiated transfers).
