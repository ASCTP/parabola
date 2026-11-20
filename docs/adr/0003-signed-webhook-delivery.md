# ADR-0003: Signed webhook delivery

- Status: Accepted
- Date: 2026-11-18

## Context

The operation surface can execute, reconcile, and index transfers, but an integrator still has to move state changes into its own systems. Polling the store works for one process and one consumer. It does not give a receiver a way to authenticate the sender, reject a replay, or retry a transient failure.

The webhook layer has to be safe by default without choosing an event bus or a hosted delivery service.

## Decision

Ship a small outbound webhook subsystem.

- `WebhookDispatcher` takes endpoints, a delivery store, and a fetch implementation.
- `enqueue()` creates one idempotent delivery per matching endpoint.
- The payload is signed with HMAC-SHA256 over the timestamp and raw body.
- `dispatchDue()` sends due deliveries and applies exponential backoff for `408`, `429`, and `5xx` responses.
- `Retry-After` can extend the delay, capped by the dispatcher's maximum delay.
- Other `4xx` responses are terminal.
- `WebhookReplayGuard` gives a receiver a bounded, expiring duplicate check.
- `MemoryWebhookDeliveryStore` and `FileWebhookDeliveryStore` are reference stores.

Delivery is at least once. The receiver verifies the signature and deduplicates on the event id.

## Consequences

Positive:

- Integrators get authenticated delivery without a new runtime dependency.
- Retry behavior is explicit and testable.
- The dispatcher accepts a fetch implementation, so tests do not need a live endpoint.
- The delivery store is a contract, so a shared implementation can replace the file store.

Negative:

- The file store is single-host.
- Endpoint management and dead-letter replay are operator work.
- At least once delivery requires receiver-side deduplication.
- The package now owns another public subpath and more contracts.

## Alternatives considered

- Deliver directly from the API request handler. Rejected because a slow or failing receiver would slow the operator surface.
- Use a hosted webhook service. Rejected because it would add a dependency and a second source of delivery state.
- Sign only the JSON body. Rejected because a timestamp inside the signed material is what makes the replay window meaningful.
- Make the receiver library responsible for durable deduplication. Rejected because the right store belongs to the receiver.

If this record is useful, consider starring the repository.
