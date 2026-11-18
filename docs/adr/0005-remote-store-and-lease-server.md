# ADR-0005: Remote store and lease server

- Status: Accepted
- Date: 2026-11-18

## Context

The durable execution and indexing layers coordinate through `TransferStore` and `IndexerCursorStore`. The memory and file stores are reference implementations. The file store uses a lock directory and per-key lease files, which coordinate processes that share one filesystem but do not give separate hosts one lease authority.

A service that runs several worker hosts needs a shared store. Adding a database driver would choose a backend for the integrator and add a dependency to the package. Leaving the store contract undocumented without a coordination option leaves every integrator to build the same protocol.

## Decision

Ship an HTTP store server and matching remote clients.

- `createStoreServer()` wraps a `TransferStore` and an optional `IndexerCursorStore`.
- `RemoteTransferStore` implements the full `TransferStore` contract, including claim, renew, and release.
- `RemoteIndexerCursorStore` implements the cursor contract.
- The server exposes `/health`, transfer CRUD, lease actions, and cursor operations.
- Lease actions run against the server's store, so every client observes one lease.
- Request bodies are bounded, `bigint` values cross the wire as strings, and errors map to HTTP status codes.
- Bearer authentication is optional. The server has no TLS or per-route authorization.
- Request metrics use `parabola_store_requests_total` and `parabola_store_request_duration_ms`.

The server is a coordination point, not a distributed database. An operator can run one server in front of a file store, or in front of a shared backend that implements the store contracts.

## Consequences

Positive:

- Multiple hosts can share records and leases without a database dependency.
- The existing store contracts stay unchanged.
- The server can wrap any store implementation, including a future database adapter.
- Tests use an ephemeral server and the same contracts as production.

Negative:

- The server is a single point of failure and a throughput bottleneck.
- A remote call adds latency to every lease renewal.
- The operator surface needs an ingress, TLS, and network access control.
- The package now owns an HTTP protocol in addition to the store contracts.

## Alternatives considered

- Add a Redis or PostgreSQL adapter. Rejected because it would choose a backend and add a dependency. The server can wrap such an adapter later.
- Tell integrators to build their own shared store. Rejected because the lease protocol and error mapping would diverge.
- Use the operations API for store access. Rejected because it exposes runtime operations, not record and lease primitives.
- Make the file store a multi-host backend. Rejected because filesystem locking semantics vary across network filesystems and cannot promise mutual exclusion.

If this record is useful, consider starring the repository.
