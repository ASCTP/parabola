import type { SettlementLogger, SettlementMetrics } from "../observability.js";
import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookDeliveryStore,
  WebhookEndpoint,
  WebhookEndpointStore,
  WebhookEvent,
  WebhookFetch,
} from "./contracts.js";
import {
  assertWebhookEndpoint,
  assertWebhookEndpoints,
} from "./endpoint-validation.js";
import {
  InvalidWebhookEventError,
  WebhookConfigurationError,
  WebhookDeliveryNotFoundError,
  WebhookDeliveryStateError,
} from "./errors.js";
import { signWebhookPayload } from "./signature.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_USER_AGENT = "parabola-webhooks/0.4";

export interface WebhookDispatcherOptions {
  endpoints?: readonly WebhookEndpoint[];
  endpointStore?: WebhookEndpointStore;
  store: WebhookDeliveryStore;
  http?: WebhookFetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  batchSize?: number;
  metrics?: SettlementMetrics;
  logger?: SettlementLogger;
  now?: () => number;
  userAgent?: string;
}

export interface WebhookDeliveryResult {
  deliveryId: string;
  eventId: string;
  endpointId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus?: number;
  error?: string;
}

export interface WebhookDispatchResult {
  startedAt: number;
  finishedAt: number;
  deliveries: WebhookDeliveryResult[];
}

type DeliveryOutcome = "delivered" | "retry" | "failed";

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function cloneEvent(event: WebhookEvent): WebhookEvent {
  return { ...event, data: structuredClone(event.data) };
}

function endpointMap(
  endpoints: readonly WebhookEndpoint[],
): Map<string, WebhookEndpoint> {
  assertWebhookEndpoints(endpoints);
  return new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
}

function matchesEvent(endpoint: WebhookEndpoint, event: WebhookEvent): boolean {
  if (endpoint.enabled === false) {
    return false;
  }
  if (!endpoint.events) {
    return true;
  }
  return endpoint.events.includes("*") || endpoint.events.includes(event.type);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(
  response: { headers: { get(name: string): string | null } },
  now: number,
): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
}

export function webhookDeliveryId(eventId: string, endpointId: string): string {
  if (eventId === "" || endpointId === "") {
    throw new RangeError("Webhook event id and endpoint id must not be empty");
  }
  return `${eventId.length}:${eventId}:${endpointId}`;
}

export class WebhookDispatcher {
  private readonly endpoints: Map<string, WebhookEndpoint> | undefined;
  private readonly endpointStore: WebhookEndpointStore | undefined;
  private readonly store: WebhookDeliveryStore;
  private readonly http: WebhookFetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly batchSize: number;
  private readonly metrics?: SettlementMetrics;
  private readonly logger?: SettlementLogger;
  private readonly now: () => number;
  private readonly userAgent: string;
  private inFlight: Promise<WebhookDispatchResult> | undefined;

  constructor(options: WebhookDispatcherOptions) {
    if (
      (options.endpoints === undefined) ===
      (options.endpointStore === undefined)
    ) {
      throw new WebhookConfigurationError(
        "Provide either endpoints or endpointStore",
      );
    }
    this.endpoints =
      options.endpoints === undefined
        ? undefined
        : endpointMap(options.endpoints);
    this.endpointStore = options.endpointStore;
    this.store = options.store;
    this.http = options.http ?? (fetch as WebhookFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    assertPositiveInteger("timeoutMs", this.timeoutMs);
    assertPositiveInteger("maxAttempts", this.maxAttempts);
    assertPositiveInteger("baseDelayMs", this.baseDelayMs);
    assertPositiveInteger("maxDelayMs", this.maxDelayMs);
    assertPositiveInteger("batchSize", this.batchSize);
  }

  listEndpoints(): Promise<WebhookEndpoint[]> {
    return this.loadEndpoints();
  }

  listFailed(limit?: number): Promise<WebhookDelivery[]> {
    return this.store.listFailed(limit);
  }

  async redeliver(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.store.get(deliveryId);
    if (!delivery) {
      throw new WebhookDeliveryNotFoundError(deliveryId);
    }
    if (delivery.status !== "failed") {
      throw new WebhookDeliveryStateError(deliveryId, delivery.status);
    }

    const now = this.now();
    delivery.status = "pending";
    delivery.attempts = 0;
    delivery.nextAttemptAt = now;
    delivery.updatedAt = now;
    delete delivery.deliveredAt;
    delete delivery.responseStatus;
    delete delivery.lastError;
    await this.store.put(delivery);

    this.metrics?.counter("parabola_webhook_replay_total", 1, {
      endpoint_id: delivery.endpointId,
    });
    this.logger?.log({
      level: "info",
      event: "webhook.delivery.replayed",
      timestamp: now,
      fields: {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        endpointId: delivery.endpointId,
      },
    });

    return delivery;
  }

  private async loadEndpoints(): Promise<WebhookEndpoint[]> {
    if (this.endpoints) {
      return [...this.endpoints.values()];
    }
    const endpoints = (await this.endpointStore?.list()) ?? [];
    assertWebhookEndpoints(endpoints);
    return endpoints;
  }

  private async endpointFor(id: string): Promise<WebhookEndpoint | undefined> {
    if (this.endpoints) {
      return this.endpoints.get(id);
    }
    const endpoint = await this.endpointStore?.get(id);
    if (endpoint) {
      assertWebhookEndpoint(endpoint);
    }
    return endpoint;
  }

  async enqueue(event: WebhookEvent): Promise<WebhookDelivery[]> {
    if (typeof event.id !== "string" || event.id.trim() === "") {
      throw new InvalidWebhookEventError("Webhook event id must not be empty");
    }
    if (typeof event.type !== "string" || event.type.trim() === "") {
      throw new InvalidWebhookEventError(
        "Webhook event type must not be empty",
      );
    }
    if (!Number.isFinite(event.createdAt)) {
      throw new InvalidWebhookEventError(
        "Webhook event createdAt must be finite",
      );
    }

    const now = this.now();
    const created: WebhookDelivery[] = [];
    const endpoints = await this.loadEndpoints();

    for (const endpoint of endpoints) {
      if (!matchesEvent(endpoint, event)) {
        continue;
      }
      const delivery: WebhookDelivery = {
        id: webhookDeliveryId(event.id, endpoint.id),
        eventId: event.id,
        endpointId: endpoint.id,
        url: endpoint.url,
        status: "pending",
        attempts: 0,
        maxAttempts: this.maxAttempts,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
        event: cloneEvent(event),
      };
      if (!(await this.store.create(delivery))) {
        continue;
      }
      created.push(delivery);
      this.metrics?.counter("parabola_webhook_enqueued_total", 1, {
        event_type: event.type,
        endpoint_id: endpoint.id,
      });
      this.logger?.log({
        level: "info",
        event: "webhook.delivery.enqueued",
        timestamp: now,
        fields: {
          deliveryId: delivery.id,
          eventId: event.id,
          eventType: event.type,
          endpointId: endpoint.id,
        },
      });
    }

    return created;
  }

  dispatchDue(now = this.now()): Promise<WebhookDispatchResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    let run: Promise<WebhookDispatchResult>;
    run = this.runDispatch(now).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = run;
    return run;
  }

  private async runDispatch(now: number): Promise<WebhookDispatchResult> {
    const startedAt = this.now();
    const due = await this.store.listDue(now, this.batchSize);
    const deliveries: WebhookDeliveryResult[] = [];
    for (const delivery of due) {
      deliveries.push(await this.deliver(delivery));
    }
    return {
      startedAt,
      finishedAt: this.now(),
      deliveries,
    };
  }

  private async deliver(
    delivery: WebhookDelivery,
  ): Promise<WebhookDeliveryResult> {
    const endpoint = await this.endpointFor(delivery.endpointId);
    if (!endpoint || endpoint.enabled === false) {
      delivery.status = "failed";
      delivery.attempts += 1;
      delivery.lastError = endpoint
        ? "Webhook endpoint is disabled"
        : "Webhook endpoint is no longer configured";
      delivery.updatedAt = this.now();
      await this.store.put(delivery);
      this.recordOutcome(delivery, "failed", 0);
      return this.resultFor(delivery);
    }

    if (delivery.status !== "pending") {
      return this.resultFor(delivery);
    }

    const startedAt = this.now();
    const attempt = delivery.attempts + 1;
    delivery.status = "delivering";
    delivery.attempts = attempt;

    const body = JSON.stringify(delivery.event, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const timestamp = Math.floor(startedAt / 1_000);
    const signature = signWebhookPayload(endpoint.secret, timestamp, body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": this.userAgent,
      "x-parabola-event-id": delivery.event.id,
      "x-parabola-event-type": delivery.event.type,
      "x-parabola-delivery-id": delivery.id,
      "x-parabola-attempt": String(attempt),
      "x-parabola-timestamp": String(timestamp),
      "x-parabola-signature": signature,
    };

    try {
      const response = await this.http(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const finishedAt = this.now();
      const duration = finishedAt - startedAt;

      if (response.ok) {
        delivery.status = "delivered";
        delivery.responseStatus = response.status;
        delivery.deliveredAt = finishedAt;
        delivery.updatedAt = finishedAt;
        delete delivery.lastError;
        await this.store.put(delivery);
        this.recordOutcome(delivery, "delivered", duration);
        return this.resultFor(delivery);
      }

      delivery.responseStatus = response.status;
      delivery.lastError = `HTTP ${response.status}`;
      const retry =
        isRetryableStatus(response.status) && attempt < delivery.maxAttempts;
      if (retry) {
        delivery.status = "pending";
        delivery.nextAttemptAt =
          finishedAt +
          this.retryDelay(attempt, retryAfterMs(response, finishedAt));
      } else {
        delivery.status = "failed";
      }
      delivery.updatedAt = finishedAt;
      await this.store.put(delivery);
      this.recordOutcome(delivery, retry ? "retry" : "failed", duration);
      return this.resultFor(delivery);
    } catch (err) {
      const finishedAt = this.now();
      const duration = finishedAt - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      delivery.lastError = message;
      const retry = attempt < delivery.maxAttempts;
      if (retry) {
        delivery.status = "pending";
        delivery.nextAttemptAt = finishedAt + this.retryDelay(attempt);
      } else {
        delivery.status = "failed";
      }
      delivery.updatedAt = finishedAt;
      await this.store.put(delivery);
      this.recordOutcome(delivery, retry ? "retry" : "failed", duration);
      return this.resultFor(delivery);
    }
  }

  private retryDelay(attempt: number, retryAfter?: number): number {
    const backoff = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.min(this.maxDelayMs, Math.max(backoff, retryAfter ?? 0));
  }

  private recordOutcome(
    delivery: WebhookDelivery,
    outcome: DeliveryOutcome,
    duration: number,
  ): void {
    this.metrics?.counter("parabola_webhook_delivery_attempt_total", 1, {
      outcome,
    });
    this.metrics?.counter("parabola_webhook_delivery_total", 1, {
      outcome,
    });
    this.metrics?.histogram("parabola_webhook_delivery_duration_ms", duration, {
      outcome,
    });
    this.logger?.log({
      level:
        outcome === "failed" ? "error" : outcome === "retry" ? "warn" : "info",
      event: `webhook.delivery.${outcome}`,
      timestamp: delivery.updatedAt,
      fields: {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        endpointId: delivery.endpointId,
        attempts: delivery.attempts,
        responseStatus: delivery.responseStatus,
        error: delivery.lastError,
      },
    });
  }

  private resultFor(delivery: WebhookDelivery): WebhookDeliveryResult {
    return {
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      status: delivery.status,
      attempts: delivery.attempts,
      responseStatus: delivery.responseStatus,
      error: delivery.lastError,
    };
  }
}
