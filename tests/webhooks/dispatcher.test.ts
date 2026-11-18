import { describe, expect, it } from "vitest";
import { MemoryLogger, MemoryMetrics } from "../../src/observability.js";
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEvent,
  WebhookFetch,
  WebhookHttpRequest,
  WebhookHttpResponse,
} from "../../src/webhooks/contracts.js";
import {
  WebhookDispatcher,
  webhookDeliveryId,
} from "../../src/webhooks/dispatcher.js";
import { MemoryWebhookEndpointStore } from "../../src/webhooks/endpoint-memory-store.js";
import {
  WebhookConfigurationError,
  WebhookDeliveryNotFoundError,
  WebhookDeliveryStateError,
} from "../../src/webhooks/errors.js";
import { MemoryWebhookDeliveryStore } from "../../src/webhooks/memory-store.js";
import { verifyWebhookSignature } from "../../src/webhooks/signature.js";

const NOW = 1_700_000_000_000;
const SECRET = "whsec_test";

function endpoint(
  overrides: Partial<WebhookEndpoint> = {},
): WebhookEndpoint {
  return {
    id: "endpoint_1",
    url: "https://example.com/hooks",
    secret: SECRET,
    ...overrides,
  };
}

function event(
  overrides: Partial<WebhookEvent> = {},
): WebhookEvent {
  return {
    id: "evt_1",
    type: "transfer.minted",
    createdAt: NOW,
    data: { idempotencyKey: "order-1", amount: 10n },
    ...overrides,
  };
}

function response(
  status: number,
  headers: Record<string, string> = {},
): WebhookHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
  };
}

interface FetchCall {
  url: string;
  request: WebhookHttpRequest;
}

function fakeFetch(
  ...results: Array<WebhookHttpResponse | Error>
): { fetch: WebhookFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: WebhookFetch = async (url, request) => {
    calls.push({ url, request });
    const result = results.shift();
    if (!result) {
      throw new Error("No fake response is configured");
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { fetch, calls };
}

function dispatcher(
  endpoints: WebhookEndpoint[],
  http: WebhookFetch,
  store = new MemoryWebhookDeliveryStore(),
  overrides: Partial<ConstructorParameters<typeof WebhookDispatcher>[0]> = {},
): WebhookDispatcher {
  return new WebhookDispatcher({
    endpoints,
    store,
    http,
    now: () => NOW,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    ...overrides,
  });
}

describe("webhook dispatcher enqueue", () => {
  it("enqueues one delivery per matching endpoint", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch();
    const subject = dispatcher(
      [
        endpoint(),
        endpoint({ id: "endpoint_2", events: ["transfer.minted"] }),
        endpoint({ id: "endpoint_3", events: ["transfer.failed"] }),
        endpoint({ id: "endpoint_4", enabled: false }),
      ],
      fetch,
      store,
    );

    const created = await subject.enqueue(event());

    expect(created.map((delivery) => delivery.endpointId)).toEqual([
      "endpoint_1",
      "endpoint_2",
    ]);
    expect(await store.list()).toHaveLength(2);
    expect(created[0]?.id).toBe(webhookDeliveryId("evt_1", "endpoint_1"));
  });

  it("does not duplicate a delivery for a repeated event", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch();
    const subject = dispatcher([endpoint()], fetch, store);

    expect(await subject.enqueue(event())).toHaveLength(1);
    expect(await subject.enqueue(event())).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });

  it("supports a wildcard event filter", async () => {
    const { fetch } = fakeFetch();
    const subject = dispatcher(
      [endpoint({ events: ["*"] })],
      fetch,
    );

    expect(await subject.enqueue(event())).toHaveLength(1);
  });

  it("loads endpoints from an endpoint store", async () => {
    const endpointStore = new MemoryWebhookEndpointStore();
    await endpointStore.create(endpoint());
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(response(200));
    const subject = new WebhookDispatcher({
      endpointStore,
      store,
      http: fetch,
      now: () => NOW,
    });

    expect(await subject.listEndpoints()).toEqual([endpoint()]);
    expect(await subject.enqueue(event())).toHaveLength(1);
  });

  it("uses endpoint changes at delivery time", async () => {
    const endpointStore = new MemoryWebhookEndpointStore();
    await endpointStore.create(endpoint());
    const store = new MemoryWebhookDeliveryStore();
    const { fetch, calls } = fakeFetch(response(200));
    const subject = new WebhookDispatcher({
      endpointStore,
      store,
      http: fetch,
      now: () => NOW,
    });
    await subject.enqueue(event());
    await endpointStore.put(
      endpoint({
        url: "https://example.com/updated",
        secret: "whsec_updated",
      }),
    );

    await subject.dispatchDue(NOW);

    const call = calls[0] as FetchCall;
    expect(call.url).toBe("https://example.com/updated");
    expect(
      verifyWebhookSignature({
        secret: "whsec_updated",
        header: call.request.headers["x-parabola-signature"],
        body: call.request.body,
        now: 1_700_000_000,
      }),
    ).toBe(true);
  });

  it("fails a delivery when its endpoint is removed from the store", async () => {
    const endpointStore = new MemoryWebhookEndpointStore();
    await endpointStore.create(endpoint());
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch();
    const subject = new WebhookDispatcher({
      endpointStore,
      store,
      http: fetch,
      now: () => NOW,
    });
    await subject.enqueue(event());
    await endpointStore.delete("endpoint_1");

    const result = await subject.dispatchDue(NOW);

    expect(result.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Webhook endpoint is no longer configured",
    });
  });

  it("rejects invalid events", async () => {
    const { fetch } = fakeFetch();
    const subject = dispatcher([endpoint()], fetch);

    await expect(
      subject.enqueue(event({ id: "" })),
    ).rejects.toThrow(/id must not be empty/);
    await expect(
      subject.enqueue(event({ type: "" })),
    ).rejects.toThrow(/type must not be empty/);
    await expect(
      subject.enqueue(event({ createdAt: Number.NaN })),
    ).rejects.toThrow(/createdAt must be finite/);
  });
});

describe("webhook dispatcher delivery", () => {
  it("posts a signed payload and records a successful delivery", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const metrics = new MemoryMetrics();
    const logger = new MemoryLogger();
    const { fetch, calls } = fakeFetch(response(200));
    const subject = dispatcher([endpoint()], fetch, store, {
      metrics,
      logger,
    });
    await subject.enqueue(event());

    const result = await subject.dispatchDue(NOW);

    expect(result.deliveries).toEqual([
      {
        deliveryId: webhookDeliveryId("evt_1", "endpoint_1"),
        eventId: "evt_1",
        endpointId: "endpoint_1",
        status: "delivered",
        attempts: 1,
        responseStatus: 200,
      },
    ]);
    expect(calls).toHaveLength(1);
    const call = calls[0] as FetchCall;
    expect(call.url).toBe("https://example.com/hooks");
    expect(call.request.method).toBe("POST");
    expect(call.request.headers["content-type"]).toBe(
      "application/json",
    );
    expect(call.request.headers["x-parabola-event-id"]).toBe("evt_1");
    expect(call.request.headers["x-parabola-event-type"]).toBe(
      "transfer.minted",
    );
    expect(call.request.headers["x-parabola-attempt"]).toBe("1");
    expect(call.request.headers["x-parabola-timestamp"]).toBe(
      "1700000000",
    );
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: call.request.headers["x-parabola-signature"],
        body: call.request.body,
        now: 1_700_000_000,
      }),
    ).toBe(true);
    expect(JSON.parse(call.request.body)).toMatchObject({
      id: "evt_1",
      type: "transfer.minted",
      data: { idempotencyKey: "order-1", amount: "10" },
    });

    const stored = await store.get(
      webhookDeliveryId("evt_1", "endpoint_1"),
    );
    expect(stored?.status).toBe("delivered");
    expect(stored?.attempts).toBe(1);
    expect(stored?.deliveredAt).toBe(NOW);
    expect(stored?.responseStatus).toBe(200);
    expect(metrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "parabola_webhook_enqueued_total",
          labels: {
            event_type: "transfer.minted",
            endpoint_id: "endpoint_1",
          },
        }),
        expect.objectContaining({
          name: "parabola_webhook_delivery_total",
          labels: { outcome: "delivered" },
        }),
      ]),
    );
    expect(logger.snapshot().map((record) => record.event)).toEqual([
      "webhook.delivery.enqueued",
      "webhook.delivery.delivered",
    ]);
  });

  it("retries a server error with backoff and then succeeds", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(
      response(500),
      response(200),
    );
    const subject = dispatcher([endpoint()], fetch, store);
    await subject.enqueue(event());

    const first = await subject.dispatchDue(NOW);
    expect(first.deliveries[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      responseStatus: 500,
      error: "HTTP 500",
    });
    expect(
      (await store.list())[0]?.nextAttemptAt,
    ).toBe(NOW + 100);

    const early = await subject.dispatchDue(NOW + 99);
    expect(early.deliveries).toEqual([]);

    const second = await subject.dispatchDue(NOW + 100);
    expect(second.deliveries[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
      responseStatus: 200,
    });
    expect(second.deliveries[0]?.error).toBeUndefined();
  });

  it("does not retry a client error", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(response(400));
    const subject = dispatcher([endpoint()], fetch, store);
    await subject.enqueue(event());

    const result = await subject.dispatchDue(NOW);

    expect(result.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      responseStatus: 400,
      error: "HTTP 400",
    });
    expect(await subject.dispatchDue(NOW + 10_000)).toMatchObject({
      deliveries: [],
    });
  });

  it("honors Retry-After when it is longer than the backoff", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(
      response(429, { "retry-after": "2" }),
      response(200),
    );
    const subject = dispatcher([endpoint()], fetch, store, {
      maxDelayMs: 10_000,
    });
    await subject.enqueue(event());

    await subject.dispatchDue(NOW);

    expect(
      (await store.list())[0]?.nextAttemptAt,
    ).toBe(NOW + 2_000);
    expect(
      (await subject.dispatchDue(NOW + 1_999)).deliveries,
    ).toEqual([]);
    expect(
      (await subject.dispatchDue(NOW + 2_000)).deliveries[0]
        ?.status,
    ).toBe("delivered");
  });

  it("retries network failures until the attempt limit", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch, calls } = fakeFetch(
      new Error("socket closed"),
      new Error("socket closed"),
    );
    const subject = dispatcher([endpoint()], fetch, store, {
      maxAttempts: 2,
    });
    await subject.enqueue(event());

    const first = await subject.dispatchDue(NOW);
    expect(first.deliveries[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "socket closed",
    });

    const second = await subject.dispatchDue(NOW + 100);
    expect(second.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "socket closed",
    });
    expect(calls).toHaveLength(2);
  });

  it("fails a delivery when its endpoint is removed", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch();
    const original = dispatcher([endpoint()], fetch, store);
    await original.enqueue(event());
    const replacement = dispatcher([], fetch, store);

    const result = await replacement.dispatchDue(NOW);

    expect(result.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Webhook endpoint is no longer configured",
    });
  });

  it("fails a delivery when its endpoint is disabled", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch();
    const original = dispatcher([endpoint()], fetch, store);
    await original.enqueue(event());
    const replacement = dispatcher(
      [endpoint({ enabled: false })],
      fetch,
      store,
    );

    const result = await replacement.dispatchDue(NOW);

    expect(result.deliveries[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "Webhook endpoint is disabled",
    });
  });

  it("reuses the in-flight dispatch instead of running twice", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(response(200));
    const subject = dispatcher([endpoint()], fetch, store);
    await subject.enqueue(event());

    const first = subject.dispatchDue(NOW);
    const second = subject.dispatchDue(NOW);

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      deliveries: [expect.objectContaining({ status: "delivered" })],
    });
  });
});

describe("webhook dispatcher replay", () => {
  it("replays a failed delivery", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const metrics = new MemoryMetrics();
    const { fetch } = fakeFetch(
      response(400),
      response(200),
    );
    const subject = dispatcher([endpoint()], fetch, store, {
      metrics,
    });
    await subject.enqueue(event());
    await subject.dispatchDue(NOW);
    const failed = (await subject.listFailed())[0] as WebhookDelivery;

    const replay = await subject.redeliver(failed.id);

    expect(replay).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: NOW,
    });
    expect((await store.get(failed.id))?.lastError).toBeUndefined();
    expect(metrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "parabola_webhook_replay_total",
          labels: { endpoint_id: "endpoint_1" },
        }),
      ]),
    );

    const result = await subject.dispatchDue(NOW);
    expect(result.deliveries[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      responseStatus: 200,
    });
  });

  it("rejects a missing delivery", async () => {
    const { fetch } = fakeFetch();
    const subject = dispatcher(
      [endpoint()],
      fetch,
      new MemoryWebhookDeliveryStore(),
    );

    await expect(
      subject.redeliver("missing"),
    ).rejects.toThrow(WebhookDeliveryNotFoundError);
  });

  it("rejects a delivery that has not failed", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const { fetch } = fakeFetch(response(200));
    const subject = dispatcher([endpoint()], fetch, store);
    await subject.enqueue(event());
    await subject.dispatchDue(NOW);

    await expect(
      subject.redeliver(
        webhookDeliveryId("evt_1", "endpoint_1"),
      ),
    ).rejects.toThrow(WebhookDeliveryStateError);
  });
});

describe("webhook dispatcher configuration", () => {
  it("requires exactly one endpoint source", () => {
    const { fetch } = fakeFetch();
    const store = new MemoryWebhookDeliveryStore();

    expect(
      () =>
        new WebhookDispatcher({
          store,
          http: fetch,
        }),
    ).toThrow(/either endpoints or endpointStore/);
    expect(
      () =>
        new WebhookDispatcher({
          endpoints: [endpoint()],
          endpointStore: new MemoryWebhookEndpointStore(),
          store,
          http: fetch,
        }),
    ).toThrow(/either endpoints or endpointStore/);
  });

  it("rejects duplicate endpoint ids", () => {
    const { fetch } = fakeFetch();

    expect(
      () =>
        dispatcher([endpoint(), endpoint()], fetch),
    ).toThrow(WebhookConfigurationError);
  });

  it("rejects invalid endpoint URLs, secrets, and ids", () => {
    const { fetch } = fakeFetch();

    expect(() =>
      dispatcher([endpoint({ url: "not a url" })], fetch),
    ).toThrow(/valid URL/);
    expect(() =>
      dispatcher([endpoint({ url: "ftp://example.com/hooks" })], fetch),
    ).toThrow(/http or https/);
    expect(() =>
      dispatcher([endpoint({ secret: "" })], fetch),
    ).toThrow(/secret must not be empty/);
    expect(() =>
      dispatcher([endpoint({ id: " " })], fetch),
    ).toThrow(/id must not be empty/);
  });

  it("rejects invalid dispatcher options", () => {
    const { fetch } = fakeFetch();

    expect(() =>
      dispatcher([endpoint()], fetch, undefined, { timeoutMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      dispatcher([endpoint()], fetch, undefined, {
        maxAttempts: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      dispatcher([endpoint()], fetch, undefined, {
        baseDelayMs: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      dispatcher([endpoint()], fetch, undefined, {
        maxDelayMs: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      dispatcher([endpoint()], fetch, undefined, {
        batchSize: 0,
      }),
    ).toThrow(RangeError);
  });

  it("builds unambiguous delivery ids", () => {
    expect(webhookDeliveryId("a:b", "c")).not.toBe(
      webhookDeliveryId("a", "b:c"),
    );
    expect(() => webhookDeliveryId("", "c")).toThrow(RangeError);
  });
});
