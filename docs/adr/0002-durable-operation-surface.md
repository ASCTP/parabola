# ADR-0002: Durable operation surface and provider conformance

- Status: Accepted
- Date: 2026-11-18

## Context

ADR-0001 separated orchestration from chain and Iris I/O. That boundary made the transfer path testable with fake providers, but a production service still had to solve the same operational problems around it:

- Replay-safe execution keyed by a caller identity.
- Leases so two processes do not drive one transfer.
- Persisted progress at the burn, attestation, and mint boundaries.
- Recovery for records whose burn or mint outcome is indeterminate.
- Chain-event indexing to turn observed transactions into reconciliation evidence.
- Cursor storage that survives restarts and handles Arc reorgs and Stellar finality differently.
- An operator surface for inspection and repair.
- A way to validate a custom provider before it handles funds.

Leaving those concerns to every integrator would produce a different, weaker settlement layer per application. It would also make the kernel boundary look optional rather than useful.

## Decision

Ship the operation surface as part of Parabola, and keep it layered over the kernel.

- `src/execution/` owns durable records, leases, evidence reconciliation, and reference stores.
- `src/indexer/` owns chain-event readers, cursor stores, and sync wrappers.
- `src/runtime.ts` is the composition root for execution and indexing.
- `src/worker.ts` drives cursor sync on an interval with per-stream failure isolation.
- `src/api.ts` and `src/cli.ts` expose the runtime over HTTP and a terminal.
- `src/observability.ts` defines metrics and structured logging contracts without choosing a backend.
- `src/conformance/` ships static adapter checks, dependency checks, and an opt-in live probe.
- `src/providers/registry.ts` validates adapters and builds the chain record the kernel consumes.

The root SDK stays stateless. A caller that only needs one transfer keeps using `transfer()`. A caller that needs replay safety, recovery, or indexing opts into the runtime subpaths.

The file stores remain single-host reference implementations. They are honest about that boundary rather than pretending to be distributed coordination.

## Consequences

Positive:

- Services can adopt replay safety and recovery without rebuilding the kernel orchestration.
- The same store and cursor contracts support embedded use, the CLI, and the HTTP API.
- Provider authors can run the same checks Parabola uses on its default adapters.
- Operators can inspect and repair records without a custom script.
- Metrics and logging stay pluggable rather than coupling the package to one backend.

Negative:

- The package has more public subpaths and more contracts to keep compatible.
- The reference file stores and operator API are not multi-host infrastructure.
- The live conformance probe submits transactions, so it remains opt-in and must run on testnet.
- More surface area means more tests and more documentation.

The trade is deliberate. A settlement layer that cannot recover an indeterminate transfer is not production infrastructure, and a provider contract without conformance checks is a suggestion.

## Alternatives considered

- Keep the operation surface outside the package. Rejected because every integrator would rebuild leases, recovery, and cursors with different semantics.
- Put the HTTP API and CLI in separate packages. Rejected because they are thin adapters over the same runtime and benefit from being versioned together.
- Ship only static conformance checks. Rejected because the burn and mint paths are where provider bugs become fund losses. The live probe is opt-in so it does not run by accident.
- Use a hosted metrics backend. Rejected because the package should not choose an operator's observability stack.

If this record is useful, consider starring the repository.
