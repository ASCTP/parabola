# ADR-0004: Webhook endpoint management and replay

- Status: Accepted
- Date: 2026-11-18

## Context

ADR-0003 shipped signed delivery with endpoints passed directly to the dispatcher. An integrator could enqueue and retry events, but could not change an endpoint without rebuilding the dispatcher. A terminal failure stayed in the delivery store with no supported way to retry it after the receiver recovered.

Both operations are routine for a webhook system. They should be available in the package rather than reimplemented by every integrator.

## Decision

Add an endpoint store contract and a replay path to the webhook subsystem.

- `WebhookEndpointStore` owns endpoint records. `MemoryWebhookEndpointStore` and `FileWebhookEndpointStore` are reference stores.
- `WebhookEndpointManager` validates endpoints, rejects duplicate ids, and reports missing endpoints on update and remove.
- `WebhookDispatcher` accepts either a static endpoint array or an endpoint store, but not both.
- An endpoint store is read on each enqueue and delivery, so changes apply without rebuilding the dispatcher.
- `WebhookDeliveryStore` adds `listFailed()`.
- `WebhookDispatcher.listFailed()` returns terminal deliveries.
- `WebhookDispatcher.redeliver(id)` resets a failed delivery to pending, clears the previous result, and restores the full attempt budget.
- Replay emits `parabola_webhook_replay_total` and a structured log entry.

## Consequences

Positive:

- Endpoint changes no longer require a restart or a new dispatcher.
- Failed deliveries have a supported inspection and retry path.
- Validation lives in one place and applies to both stores.
- Static endpoints remain available for tests and small deployments.

Negative:

- The file stores are still single-host.
- Replay is an operator call. There is no scheduler that retries dead letters automatically.
- The delivery store contract gained a method, so external implementations must add it.
- A static endpoint array does not observe later changes. Callers that need live changes must use a store.

## Alternatives considered

- Keep endpoint management outside the package. Rejected because every integrator would repeat the same validation and storage work.
- Add automatic dead-letter retries. Rejected for this slice because it needs an operator policy for timing, limits, and alerting.
- Let `redeliver()` resume from the previous attempt count. Rejected because a terminal failure may have exhausted the budget and the operator has already decided the receiver is healthy again.
- Replace the static endpoint option entirely. Rejected because it keeps tests and single-process use simple.

If this record is useful, consider starring the repository.
