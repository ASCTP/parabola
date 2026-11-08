# ADR-0001: Kernel and provider boundary

- Status: Accepted
- Date: 2026-11-08

## Context

Parabola began as a two-corridor SDK for Arc and Stellar. Transfer orchestration, chain-specific transaction construction, and Iris polling were mixed across `src/transfer.ts`, `src/chains/`, and `src/iris/`. That shape made the public API work, but it made three future requirements expensive:

- Testing orchestration without mocking chain modules.
- Adding durable execution, recovery, and reconciliation.
- Adding a CLI, service, or new chain without copying transfer logic.

The public behavior is correct and tested. The problem is the boundary, not the protocol logic.

## Decision

Introduce a chain-agnostic kernel and a provider boundary.

- The kernel owns planning, orchestration, the transfer state machine, and error wrapping. It has no network I/O.
- `ChainAdapter` owns chain-specific burn and mint calls.
- `AttestationAdapter` owns Iris reads and polling.
- `FeeAdapter` owns fast-transfer fee quotes.
- Default adapters in `src/providers/default.ts` wrap the existing Arc, Stellar, and Iris functions.
- `src/transfer.ts` delegates to a kernel built from those default adapters.

The public API and its behavior stay unchanged in this slice.

## Consequences

Positive:

- Orchestration can be tested with fake providers and no network mocks.
- The same kernel can later be driven by a durable executor, CLI, or HTTP service.
- New chains are provider work rather than changes to transfer orchestration.
- The state machine gives recovery a defined vocabulary.

Negative:

- One more layer of indirection.
- More types to maintain.
- Adapters must preserve the current argument shapes until the public API changes.

The boundary is worth the cost because it turns a correct SDK into a reusable settlement kernel.

## Alternatives considered

- Keep the monolith and refactor later. Rejected because every new interface would copy orchestration and increase the eventual migration cost.
- Build the durable executor first. Rejected because persistence needs a stable state machine and provider contract.
- Use an external workflow engine. Rejected because it would add a runtime dependency before the core contract exists.

If this record is useful, consider starring the repository.
