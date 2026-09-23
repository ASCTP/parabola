# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-23

### Added

- Mainnet support for both Arc and Stellar. `transfer()`, `estimateFee()`, `completeMint()`, and `checkStellarRecipientReady()` accept an optional `network` parameter (`"mainnet"` or `"testnet"`) that selects contract addresses, RPC endpoints, and the Circle Iris environment.
- `arcMainnetChain`, `ARC_MAINNET`, `STELLAR_MAINNET`, and the `Network` type are exported from the package root alongside the existing testnet values.
- `options.stellarRpcUrl` to override the Soroban RPC per call. Defaults to `https://mainnet.sorobanrpc.com` on mainnet and `https://soroban-testnet.stellar.org` on testnet.
- `scripts/verify-contract-addresses.mjs` now verifies mainnet addresses in addition to testnet.

### Changed

- **Breaking:** `network` defaults to `"mainnet"`. A 0.2.0 caller that upgrades and does not pass `network` will transact on Arc and Stellar mainnet, moving real USDC and spending real Arc gas. Pass `network: "testnet"` to keep the previous testnet behavior.
- **Breaking:** removed `useSandbox` from `TransferOptions` and `CompleteMintParams`. The Iris environment is now derived from `network` (`testnet` uses the Iris sandbox), so `useSandbox` is no longer needed. Callers that set it should pass `network: "testnet"` instead.
- `pnpm smoke` still defaults to testnet for safety; set `NETWORK=mainnet` to smoke against mainnet.

## [0.2.0] - 2026-08-14

### Changed

- **Breaking:** package renamed from `@drydocs/parabola` to `@asctp/parabola`, following the project's move to its own dedicated GitHub organization (`ASCTP`). `@drydocs/parabola` is deprecated; install `@asctp/parabola` going forward.

### Added

- Initial `transfer()` and `estimateFee()` exports for moving USDC between Arc testnet and Stellar testnet via CCTP V2.
- `completeMint()` for finishing a transfer left `"pending"` when no `destinationSigner` was provided.
- Stellar address encoding, `CctpForwarder` routing, and 6/7-decimal precision conversion utilities.
- `TransferError`, carrying `burnTxHash` (and `attestationHash` when available), for any failure that happens after the source-chain burn has already succeeded.
- `SubmissionTimeoutError`, carrying a transaction hash, for a broadcast transaction whose confirmation timed out before its outcome was known. Both are exported from the package root.
- `tests/amount.test.ts`, covering the Arc/Stellar decimal-precision wiring in `src/utils/amount.ts` directly; previously only the lower-level parsing primitives it wraps were tested.
- `checkStellarRecipientReady()`, exported from the package root, to check whether a Stellar address exists on-ledger and holds a USDC trustline before a transfer is attempted. `transfer()` now calls it automatically before any Arc-side approval or burn on an Arc-to-Stellar transfer, throwing a clear pre-burn error instead of letting the burn go through and only failing later at `mint_and_forward` with the USDC stuck at the CctpForwarder.

### Fixed

Found by running the wallet-connected demo app against live testnet in both directions, repeatedly, across many real transfers; none of these were catchable by mocked unit tests either:

- `transfer()` only ever returned `burnTxHash` on success. Any failure after the burn (an attestation-polling timeout, a mint-step error, a burn confirmation that timed out without a definite outcome) threw a bare `Error` and the hash was gone for good, with no way to recover via `completeMint()`. Now rethrown as `TransferError`/`SubmissionTimeoutError` carrying the hash.
- Iris's fees endpoint (`burn/USDC/fees/{source}/{destination}`) returns a bare array, not `{ data: [...] }` as the code assumed. Every fast-transfer fee lookup threw `TypeError: can't access property 'find', body.data is undefined`.
- `approveUsdcOnStellar` confirming (`SUCCESS` status) didn't guarantee a subsequent `deposit_for_burn` call would see that approval: an RPC read-after-write race between the two calls could produce a stale allowance read (`not enough allowance to spend`) or a stale account sequence number (`txBadSeq`), even though the approval had genuinely landed. `approveUsdcOnStellar` now actively polls the real on-chain allowance before returning, and `burnUsdcOnStellar` retries once more on either of those two specific transient errors.
- Stellar's transaction validity window (`.setTimeout(60)`) and confirmation-wait timeout were both tuned for machine-speed signing. Once a human is in the loop approving a wallet popup (Freighter), 60 seconds was routinely too short, failing with `txTooLate` or a confirmation timeout on transactions that had nothing wrong with them. Bumped to 180s and 120s respectively.
- **(security)** `evmAddressToBytes32` and `encodeStellarForwardHook` never validated the recipient address they were given. A truncated, malformed, or otherwise garbage `recipient` string was silently encoded into a syntactically valid but wrong bytes32 value, and `transfer()` would proceed to burn real funds on the source chain toward it, funds effectively unrecoverable. Both now throw before the burn is ever submitted if the recipient isn't a real address for its chain. Found in a dedicated security review, not live testing.

### Changed

- **Breaking:** minimum supported Node.js bumped `>=18` -> `>=20`. The `@stellar/stellar-sdk@16.2.0` upgrade pulled in a `@noble/ed25519` version that requires `globalThis.crypto`, which Node 18 doesn't expose by default (this surfaced as CI failures on the Node 18 matrix job, not a theoretical concern). Node 18 has also been EOL since April 2025.
- Removed `convertAmountBetweenChains`, a thin wrapper around already-exported functions that had no callers anywhere in the SDK, the demo app, or the tests.
