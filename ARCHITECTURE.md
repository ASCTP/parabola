# Architecture

Status: accepted for the current slice.

## Purpose

Parabola is a settlement kernel for moving native USDC across CCTP domains. The public SDK is one interface to that kernel. The kernel owns orchestration and transfer state. Providers own all network I/O. The boundary exists so the same transfer can be driven by the SDK today and by a durable executor, CLI, or service later without rewriting the protocol logic.

## System shape

- `src/kernel/` contains chain-agnostic orchestration, the transfer state machine, kernel errors, and the provider contracts. It performs no network I/O.
- `src/execution/` contains the durable transfer record, the idempotent executor, and in-memory and local-file stores. It depends on the kernel contract rather than the provider implementations.
- `src/providers/` contains the default adapters. These wrap the existing Arc, Stellar, and Iris code behind the provider contracts.
- `src/chains/` contains chain-specific transaction construction and submission.
- `src/iris/` contains Circle attestation and fee reads.
- `src/utils/` contains pure codecs, amount conversion, and CCTP message decoding.
- `src/transfer.ts` is the stable public entry point. It delegates to a kernel built from the default providers.
- `src/estimate.ts` remains a public fee estimate entry point.
- `src/index.ts` is the package export surface.

## Dependency rule

- The kernel depends on contracts, state, errors, protocol constants, and pure utilities. It never imports chain, Iris, HTTP, or runtime I/O.
- The execution layer depends on the kernel contract and public types. It performs no chain, Iris, or HTTP I/O; the file store is the only runtime I/O in this layer.
- Providers depend on the kernel contracts. They may import chain, Iris, constants, and utility modules.
- The public API depends on the kernel and the default providers.
- No provider imports the kernel implementation.

This rule is what makes the kernel testable with fake providers and what will let a future executor reuse the same orchestration without the SDK.

## Transfer state machine

- planned -> burning on BURN_STARTED.
- planned -> failed on BURN_FAILED.
- burning -> burned on BURN_CONFIRMED.
- burning -> failed on BURN_FAILED.
- burned -> attesting on ATTESTATION_STARTED.
- burned -> recoverable on RECOVERY_REQUIRED.
- attesting -> attested on ATTESTATION_READY.
- attesting -> recoverable on RECOVERY_REQUIRED.
- attested -> minting on MINT_STARTED.
- attested -> pending on DEFERRED.
- attested -> recoverable on RECOVERY_REQUIRED.
- minting -> minted on MINT_CONFIRMED.
- minting -> recoverable on RECOVERY_REQUIRED.

`minted`, `pending`, `recoverable`, and `failed` are terminal in this slice. An invalid transition throws `InvalidStateTransitionError` with the phase and event.

`recoverable` means the source-chain burn exists but the transfer did not finish. The executor persists this phase and the recovery hashes.

## Durable execution

`executeTransfer` wraps a `SettlementKernel` with a `TransferStore` keyed by a caller-supplied idempotency key. It creates the record atomically, persists `burning` before calling the kernel, then records each progress event the kernel emits. A repeated key must match the original from, to, network, amount, and recipient, or it raises `TransferConflictError` with reason `mismatch`. A repeated key replays the stored result for `minted` or `pending`. `TransferError` maps to `recoverable` because the source-chain burn exists. Any other failure maps to `failed`. Signers are never written to the store.

The kernel emits progress at the durable boundaries: fee selection, burn confirmation, attestation readiness, mint start, and terminal state. The executor persists each event before the kernel continues, so a confirmed burn is recorded before attestation polling begins. If progress persistence fails, the kernel stops rather than advancing past an unrecorded boundary.

When a record has a burn hash and is in `burned`, `attesting`, `attested`, or `recoverable`, a repeated call with a destination signer resumes through `completeMint` instead of repeating the burn. The resulting record is reconciled into `minted` with the original transfer mode and fee when they were recorded.

`TransferStore.create` must be atomic. `MemoryTransferStore` is for tests and single-process use. `FileTransferStore` is a single-host reference store with one JSON file per key, atomic creation, and temporary-file rename for updates. It is not a distributed lock, and it does not coordinate writers across processes.

This layer does not yet collect leases or renew them, so concurrent processes need external coordination. A record left in `burning` without a burn hash is indeterminate because the burn may have landed, and a record left in `minting` is indeterminate because the mint may have landed. Neither is resumed automatically. Those cases require a reconciler that can inspect source and destination chain state. The next execution slice adds leases and that reconciliation.

## Provider contract

`ChainAdapter` owns chain-specific burns and mints. It receives a `BurnRequest` or `MintRequest` and returns a receipt with a transaction hash. A destination adapter may implement `assertCanReceive` when the destination has preconditions, as Stellar does with account existence and the USDC trustline.

`AttestationAdapter` owns Circle Iris reads and polling. It returns an `AttestationRecord` with the attestation bytes, the CCTP message bytes, and the Iris status.

`FeeAdapter` owns fast-transfer fee quotes.

Adapters must not mutate their request objects. They must return a non-empty transaction hash on success. They must surface provider failures as errors rather than returning a synthetic success.

## Error model

The public error classes in `src/errors.ts` remain the contract for callers. The kernel preserves them:

- `SubmissionTimeoutError` from a source burn becomes a `TransferError` carrying the burn hash.
- `AttestationNotReadyError` after a burn becomes a `TransferError` with `code === "ATTESTATION_NOT_READY"`.
- `completeMint` and `resolveBurn` propagate `AttestationNotReadyError` unwrapped.
- The kernel never discards a burn hash after the source-chain burn has been submitted.

`KernelError` and `InvalidStateTransitionError` are internal in this slice. They describe programming errors in the state machine, not protocol failures.

## Current slices

The kernel slice introduces the boundary without changing public behavior:

- `transfer`, `completeMint`, and `resolveBurn` delegate to `createSettlementKernel(defaultSettlementDependencies)`.
- The default adapters call the same Arc, Stellar, and Iris functions as before, with the same arguments.
- The state machine runs inside the kernel and is covered by tests.
- A provider conformance test exercises the `ChainAdapter` contract with fake adapters.
- The existing transfer, mint, and attestation tests continue to pass unchanged.

The execution slice adds idempotent persistence and burn recovery around the kernel:

- `executeTransfer` is covered for success, pending replay, minted replay, key mismatch, conflicts, progress persistence, recoverable and failed errors, persistence failures, and concurrent calls.
- `executeTransfer` resumes `burned`, `attesting`, `attested`, and `recoverable` records through `completeMint` when a destination signer is available.
- The kernel is covered for success, pending, complete-mint, and progress-failure event sequences.
- `MemoryTransferStore` is exercised through the executor for record create, update, and replay.
- `FileTransferStore` is covered for atomic create, replacement, deletion, unsafe keys, and persistence across store instances.

## Non-goals

This slice does not add distributed leases, lease renewal, reconciliation of indeterminate burns or mints, a CLI, an HTTP API, new chains, or a public provider SDK. Those depend on a stable execution contract and belong in later slices.

## Next slices

1. Leases and reconciliation for `burning` and `minting` records.
2. An indexer and reconciler over chain events and Iris state.
3. CLI and HTTP interfaces that drive the same kernel.
4. A shipped provider conformance package and provider registry.
5. Observability, compatibility policy, and release automation.

## Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

If Parabola is useful to you, consider starring the repository.
