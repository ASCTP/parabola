# Architecture

Status: accepted for the current slice.

## Purpose

Parabola is a settlement kernel for moving native USDC across CCTP domains. The public SDK is one interface to that kernel. The kernel owns orchestration and transfer state. Providers own all network I/O. The boundary exists so the same transfer can be driven by the SDK, a durable executor, a CLI, or an HTTP service without rewriting the protocol logic.

## System shape

- `src/kernel/` contains chain-agnostic orchestration, the transfer state machine, kernel errors, and the provider contracts. It performs no network I/O.
- `src/execution/` contains the durable transfer record, the idempotent executor, the evidence reconciler, and in-memory and local-file stores. It depends on the kernel contract rather than the provider implementations.
- `src/indexer/` contains chain-event readers that produce reconciliation evidence, cursor stores for tracking indexed positions, and sync wrappers that advance cursors. The Arc wrapper rewinds on reorgs. The Stellar wrapper verifies ledger hashes and treats a mismatch as a hard error because Stellar ledgers are final. It indexes Arc `DepositForBurn` and `MessageReceived` logs, and Stellar `deposit_for_burn` and `mint_and_forward` contract events.
- `src/providers/` contains the default adapters and the `ChainAdapterRegistry`. The adapters wrap the existing Arc, Stellar, and Iris code behind the provider contracts. The registry validates adapters, rejects duplicate chains, and builds the `chains` record.
- `src/conformance/` contains the shipped provider conformance checks. Static checks validate adapter and dependency shape. The live probe is opt-in and exercises burn, mint, and recipient checks with caller-supplied values.
- `src/chains/` contains chain-specific transaction construction and submission.
- `src/iris/` contains Circle attestation and fee reads.
- `src/utils/` contains pure codecs, amount conversion, and CCTP message decoding.
- `src/transfer.ts` is the stable public entry point. It delegates to a kernel built from the default providers.
- `src/estimate.ts` remains a public fee estimate entry point.
- `src/runtime.ts` composes the default kernel, the durable executor, the reconciler, and the indexers into one operation surface.
- `src/worker.ts` runs the configured indexer streams once or on an interval, isolates per-stream failures, and records task and cycle metrics.
- `src/api.ts` serves the operator HTTP API over the same store and cursor contracts.
- `src/store-server.ts` exposes the store and cursor contracts over HTTP for remote clients.
- `src/store-http.ts` and `src/http-json.ts` provide the remote store client and shared JSON request handling.
- `src/cli.ts` and `src/cli-entry.ts` provide the `parabola` operator CLI.
- `src/observability.ts` defines the metrics and structured logging contracts and reference implementations.
- `src/webhooks/` contains signed outbound delivery, retry policy, endpoint management, dead-letter replay, replay protection, and memory and file endpoint and delivery stores. It depends on execution record types and observability contracts, not on the kernel or providers.
- `src/index.ts` is the root package export surface. `src/execution/index.ts`, `src/indexer/index.ts`, `src/runtime.ts`, `src/api.ts`, `src/observability.ts`, `src/conformance/index.ts`, `src/providers/index.ts`, and `src/webhooks/index.ts` are separate package subpaths.

## Dependency rule

- The kernel depends on contracts, state, errors, protocol constants, and pure utilities. It never imports chain, Iris, HTTP, or runtime I/O.
- The execution layer depends on the kernel contract and public types. It performs no chain, Iris, or HTTP I/O; the file store is the only runtime I/O in this layer.
- The indexer depends on execution records and reconciler outcomes. It reads chain events and writes only through the store and reconciler.
- Providers depend on the kernel contracts. They may import chain, Iris, constants, and utility modules.
- The conformance layer depends on the kernel contracts and public types. It performs no I/O unless the caller invokes the live probe.
- The provider registry depends on the conformance checks and the kernel contracts.
- The runtime is the composition root. It may import the default kernel, providers, execution, indexer, and worker.
- The HTTP API and CLI depend on the runtime, execution, and indexer contracts. The observability layer has no dependency on settlement code.
- The webhook layer depends on execution record types and observability contracts. It performs network I/O only when the dispatcher delivers a queued event.
- The public API depends on the kernel, the default providers, and the runtime composition root.
- No provider imports the kernel implementation.

This rule is what makes the kernel testable with fake providers and lets the executor and indexer reuse the same orchestration without the SDK.

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

`executeTransfer` wraps a `SettlementKernel` with a `TransferStore` keyed by a caller-supplied idempotency key. It creates the record atomically, persists `burning` before calling the kernel, then records each progress event the kernel emits. A repeated key must match the original from, to, network, amount, recipient, and stored source address, or it raises `TransferConflictError` with reason `mismatch`. A repeated key replays the stored result for `minted` or `pending`. `TransferError` maps to `recoverable` because the source-chain burn exists. Any other failure maps to `failed`. The public source address is stored for reconciliation; signers are never written to the store.

The kernel emits progress at the durable boundaries: fee selection, burn confirmation, attestation readiness, mint start, and terminal state. The executor persists each event before the kernel continues, so a confirmed burn is recorded before attestation polling begins. If progress persistence fails, the kernel stops rather than advancing past an unrecorded boundary.

When a record has a burn hash and is in `burned`, `attesting`, `attested`, or `recoverable`, a repeated call with a destination signer resumes through `completeMint` instead of repeating the burn. The resulting record is reconciled into `minted` with the original transfer mode and fee when they were recorded.

`TransferStore.create` must be atomic. `MemoryTransferStore` is for tests and single-process use. `FileTransferStore` is a single-host reference store with one JSON file per key, atomic creation, and temporary-file rename for updates.

Every execution claims a lease before it reads, creates, resumes, or mutates a transfer record. A busy lease raises `TransferConflictError` with reason `in_progress`. The executor generates a lease owner per call, renews the lease before each persisted progress event, and releases it in a `finally` block. A lost lease raises `TransferLeaseLostError` and stops the run. Terminal records with a stored result can still be replayed without taking a lease.

The file store serializes claim operations with a short-lived lock directory and stores leases in per-key `.lease` files. Expired leases are reclaimable, and every store instance observes the same lease because the files live beside the records. This is a single-host coordination mechanism. It does not provide multi-host mutual exclusion by itself.

`createStoreServer` centralizes a `TransferStore` and an optional `IndexerCursorStore` behind an HTTP protocol. `RemoteTransferStore` and `RemoteIndexerCursorStore` implement the same contracts as clients. Record operations, lease claims, renewals, and releases all run against the server's store, so every client observes the same lease. The server is a single coordination point, not a distributed database. Bearer authentication is optional, and the server is an operator surface that belongs behind an ingress.

A record left in `burning` without a burn hash is indeterminate because the burn may have landed. A record left in `minting` is indeterminate because the mint may have landed. Neither is resumed automatically.

`reconcileTransfer` applies externally observed evidence to those records under the same lease discipline as the executor. Burn evidence promotes `planned` or `burning` to `burned`. Mint evidence promotes any non-terminal, non-failed record that has a burn hash to `minted` and reconstructs the result. Evidence that contradicts a stored hash raises `TransferEvidenceError`, and `failed` records remain terminal. The reconciler does not scan chains or read Iris.

## Chain event indexing

`indexArcBurns` scans a caller-supplied Arc block range for `DepositForBurn` logs and reconciles `burning` Arc-to-Stellar records. It matches on USDC, depositor, amount, destination domain, mint recipient, and Stellar forward hook. A record must have a stored `sourceAddress`; records without one are reported as skipped. Zero matches are reported as unmatched, multiple matches as ambiguous, and a held lease as busy.

`indexStellarBurns` scans a caller-supplied Soroban ledger range for `deposit_for_burn` contract events and reconciles `burning` Stellar-to-Arc records. It matches on the USDC contract, depositor, canonical six-decimal amount, destination domain, and EVM mint recipient. Event pagination follows the RPC cursor until the ledger range is exhausted. Decoding failures, failed contract calls, and unrelated events are ignored.

`indexArcMints` scans Arc `MessageReceived` logs and reconciles Stellar-to-Arc records that already have a burn hash. It decodes the CCTP burn body, matches the Stellar source domain, source `TokenMessengerMinter`, USDC contract, canonical amount, and EVM mint recipient, and rejects messages that carry hook data. Malformed or unrelated message bodies are ignored rather than treated as matches.

`indexStellarMints` scans Stellar `mint_and_forward` events on the `CctpForwarder` and reconciles Arc-to-Stellar records that already have a burn hash. It matches the forwarded Stellar recipient, USDC contract, and seven-decimal amount. Event pagination follows the RPC cursor until the ledger range is exhausted.

`IndexerCursorStore` persists a stream name, block number, block hash, and update time. The memory store is for tests and embedded use; the file store writes one JSON document per stream with an atomic rename.

`syncArcBurns` and `syncArcMints` read the cursor, compute a safe tip from the latest block minus caller-supplied confirmations, and scan only the uncovered range. They verify the cursor block hash against the canonical chain. A mismatch rewinds by `reorgWindow` blocks, clamped to the start block, then rescans. A cursor ahead of the safe tip is treated the same way. The new cursor is written only after the scan succeeds.

`syncStellarBurns` and `syncStellarMints` read the cursor, resolve the latest Stellar ledger, and scan only the uncovered ledger range. They verify the cursor ledger hash and throw `IndexerCursorError` when the ledger is missing or no longer canonical. A cursor ahead of the latest ledger is also an error. Stellar ledgers are final, so there is no reorg rewind path. The new cursor is written only after the scan succeeds.

Both sync wrappers advance the cursor even when no candidates exist, so a transfer created after its burn block was scanned needs an explicit cursor reset or backfill.

## Operation surface

`createSettlementRuntime(store, options?)` binds the default kernel, the executor, the reconciler, and the indexers to one `TransferStore`. It exposes `execute`, `reconcile`, `resolveBurn`, the four range indexers, and the four cursor sync wrappers. A caller can inject a different kernel for testing or a custom deployment.

The runtime is exported from `@asctp/parabola/runtime`. The execution and indexer contracts are exported from `@asctp/parabola/execution` and `@asctp/parabola/indexer` so a service can construct its own composition without importing the root SDK.

`createIndexerWorker` drives the sync wrappers. It requires at least one configured Arc or Stellar stream, runs each stream independently with `Promise.allSettled`, and reports a cycle result with per-task success or failure. A failure in one stream does not stop the others. `start()` loops until `stop()` or the caller's abort signal fires. The worker emits task and cycle metrics when a `SettlementMetrics` implementation is supplied.

`createApiServer` exposes the runtime over HTTP. It uses Node's `http` module, a bearer token when configured, JSON request bodies, and a shared error mapping. `/health` is public. Transfer reads, evidence reconciliation, range indexing, and cursor sync require the token. Request bodies are bounded, `bigint` values are serialized as strings, and every completed request emits metrics and an optional `onRequest` event. The API is an operator surface, not a public gateway.

The CLI wraps the runtime and worker with file-backed stores. `list`, `reconcile`, and `resolve` are one-shot commands. `sync` runs one cycle or watches on an interval. `serve` starts the HTTP API and shuts down cleanly on `SIGINT` or `SIGTERM`. `--json` makes every command machine-readable.

`@asctp/parabola/observability` defines `SettlementMetrics` and `SettlementLogger`. The API uses `parabola_api_requests_total` and `parabola_api_request_duration_ms`. The store server uses `parabola_store_requests_total` and `parabola_store_request_duration_ms`. The worker uses `parabola_indexer_task_total`, `parabola_indexer_task_duration_ms`, `parabola_indexer_cycle_total`, and `parabola_indexer_cycle_duration_ms`. The webhook dispatcher uses `parabola_webhook_enqueued_total`, `parabola_webhook_delivery_attempt_total`, `parabola_webhook_delivery_total`, `parabola_webhook_delivery_duration_ms`, and `parabola_webhook_replay_total`. `MemoryMetrics`, `MemoryLogger`, and `JsonLogger` are reference implementations, not a metrics backend.

`@asctp/parabola/webhooks` adds outbound delivery. `WebhookDispatcher` enqueues one delivery per matching endpoint, signs the raw body with HMAC-SHA256, retries `408`, `429`, and `5xx` responses with exponential backoff, honors `Retry-After`, and stops after the configured attempt limit. `WebhookReplayGuard` rejects duplicate event ids at the receiver. `MemoryWebhookEndpointStore`, `FileWebhookEndpointStore`, `MemoryWebhookDeliveryStore`, and `FileWebhookDeliveryStore` are reference stores. `WebhookEndpointManager` validates endpoint changes and rejects duplicate ids. `listFailed()` and `redeliver()` expose dead-letter inspection and replay. Delivery is at least once, so receivers must verify the signature and deduplicate on the event id. The dispatcher accepts a caller-supplied fetch implementation, so tests do not need a live endpoint.

## Provider contract

`ChainAdapter` owns chain-specific burns and mints. It receives a `BurnRequest` or `MintRequest` and returns a receipt with a transaction hash. A destination adapter may implement `assertCanReceive` when the destination has preconditions, as Stellar does with account existence and the USDC trustline.

`AttestationAdapter` owns Circle Iris reads and polling. It returns an `AttestationRecord` with the attestation bytes, the CCTP message bytes, and the Iris status.

`FeeAdapter` owns fast-transfer fee quotes.

Adapters must not mutate their request objects. They must return a non-empty transaction hash on success. They must surface provider failures as errors rather than returning a synthetic success.

## Provider conformance and registry

`@asctp/parabola/conformance` ships the checks that enforce the provider contract.

`assertChainAdapterConforms` is a static check. It validates the chain identity, the presence of `burn` and `mint`, and the optional `assertCanReceive` method. It performs no I/O and is safe to run in unit tests.

`assertSettlementDependenciesConform` validates a complete `SettlementDependencies` value. It requires both chain adapters in the correct slots, the attestation `read` and `poll` methods, and the fee adapter.

`probeChainAdapter` is the opt-in live check. It calls the recipient check first when the adapter implements one, then the burn path, then the mint path. It requires a network, amount, recipient, signer, message, and attestation from the caller, because a live probe must not invent addresses or reuse stale attestations. It rejects an empty transaction hash with a `ConformanceError` that names the failed check. Running it submits real transactions and should use testnet funds.

`ChainAdapterRegistry` in `@asctp/parabola/providers` validates each adapter, rejects duplicate chain registrations, resolves adapters by chain, and builds the `chains` record. The default dependency set is constructed through the registry, so a malformed default adapter fails at module load rather than on the first transfer.

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
- The shipped conformance harness exercises the `ChainAdapter` contract with fake adapters.
- The existing transfer, mint, and attestation tests continue to pass unchanged.

The execution slice adds idempotent persistence and burn recovery around the kernel:

- `executeTransfer` is covered for success, pending replay, minted replay, key mismatch, conflicts, progress persistence, recoverable and failed errors, persistence failures, concurrent calls, lease release, lease contention, and lost leases.
- `executeTransfer` resumes `burned`, `attesting`, `attested`, and `recoverable` records through `completeMint` when a destination signer is available.
- The kernel is covered for success, pending, complete-mint, and progress-failure event sequences.
- `MemoryTransferStore` is covered for record create, update, replay, claim, renew, release, expiry, and deletion.
- `FileTransferStore` is covered for atomic create, replacement, deletion, unsafe keys, persistence across store instances, lease claims, renewal, release, expiry, and concurrent claims.
- The remote store server and clients are covered for record CRUD, shared lease claims, unsafe keys, cursor serialization, authentication, request validation, metrics, and route handling.
- `reconcileTransfer` is covered for burn promotion, mint promotion, conflicting evidence, missing evidence, terminal records, lease contention, and persistence failures.
- `indexArcBurns` is covered for matching burns, unmatched records, ambiguous matches, missing source addresses, busy leases, testnet selection, and invalid block ranges.
- `indexStellarBurns` is covered for event decoding, matching burns, unmatched records, ambiguous matches, missing source addresses, busy leases, testnet selection, pagination, ledger-range stopping, failed contract calls, and invalid ledger ranges.
- `indexArcMints` is covered for matching mints, unmatched records, ambiguous matches, malformed bodies, hook rejection, source-domain and sender filtering, busy leases, testnet selection, and invalid block ranges.
- `indexStellarMints` is covered for matching mints, unmatched records, ambiguous matches, recipient and token filtering, busy leases, testnet selection, pagination, failed contract calls, and invalid ledger ranges.
- `decodeCctpBurnBody` is covered against a live testnet burn body and for short-body rejection.
- `MemoryIndexerCursorStore` and `FileIndexerCursorStore` are covered for round-tripping, overwrites, deletion, missing streams, encoded file names, decimal block-number persistence, cross-instance persistence, and invalid cursors.
- `syncArcBurns` and `syncArcMints` are covered for first scans, canonical resume, cursor-at-tip, reorg rewinds, deep rewinds, cursor-ahead rewinds, missing cursor blocks, missing tip blocks, safe-tip-before-start, custom streams, invalid settings, and end-to-end burn and mint reconciliation.
- `syncStellarBurns` and `syncStellarMints` are covered for first scans, canonical resume, cursor-at-tip, missing cursor ledgers, hash mismatches, cursor-ahead errors, missing tip ledgers, latest-before-start, custom streams, invalid start ledgers, and end-to-end burn and mint reconciliation.
- `createSettlementRuntime` is covered for durable execution, evidence reconciliation, read-only burn resolution, empty-store indexing, and default-kernel construction.
- The execution and indexer subpaths are covered for their expected value exports.
- The stores are covered for record listing in deterministic order.
- `createIndexerWorker` is covered for multi-stream cycles, per-stream switches, isolated failures, interval validation, stop behavior, aborted startup, and task and cycle metrics.
- `createApiServer` is covered for health, bearer authentication, transfer listing and reads, evidence reconciliation, Arc and Stellar range indexing, Arc and Stellar cursor sync, request metrics, malformed JSON, content type, body limits, invalid networks, invalid block numbers, unknown routes, and wrong methods.
- The CLI is covered for parsing, unknown flags, required arguments, one-shot commands, sync cycles, JSON output, and watch shutdown wiring.
- `MemoryMetrics`, `MemoryLogger`, and `JsonLogger` are covered for recording, label isolation, reset behavior, bigint serialization, and structured records.
- The conformance harness is covered for static adapter checks, live probe ordering, empty hashes, skipped recipient checks, complete dependency checks, missing methods, and wrong chain slots.
- `ChainAdapterRegistry` is covered for registration, resolution, duplicate rejection, conformance rejection, and incomplete records.
- `WebhookDispatcher` is covered for endpoint filtering, idempotent enqueue, signed payloads, successful delivery, retries, `Retry-After`, client errors, network failures, missing and disabled endpoints, endpoint store changes, dead-letter replay, in-flight deduplication, metrics, and logs.
- `WebhookReplayGuard`, `WebhookEndpointManager`, the endpoint stores, the delivery stores, and `transferWebhookEvent` are covered for replay windows, expiry, eviction, endpoint validation, persistence, due and failed ordering, unsafe ids, and phase mapping.
- The API, observability, conformance, provider, and webhook subpaths are covered for their expected value exports.

## Non-goals

Parabola does not provide a distributed database or a multi-writer file store, a hosted webhook management UI, automatic dead-letter scheduling, per-route authorization, rate limiting, TLS termination, gas abstraction, or chains beyond Arc and Stellar. The store server centralizes lease authority for remote clients but remains a single coordination point. The HTTP API and store server are operator surfaces that belong behind an ingress and identity layer. The metrics and logging contracts are integration points, not a hosted observability backend.

## Next slices

1. Gas abstraction and additional CCTP domains.
2. Compatibility policy and release automation.

## Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `npm pack --dry-run`

If Parabola is useful to you, consider starring the repository.
