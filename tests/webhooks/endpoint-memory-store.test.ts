import { describe, expect, it } from "vitest";
import type { WebhookEndpoint } from "../../src/webhooks/contracts.js";
import { MemoryWebhookEndpointStore } from "../../src/webhooks/endpoint-memory-store.js";

function endpoint(
  id: string,
  overrides: Partial<WebhookEndpoint> = {},
): WebhookEndpoint {
  return {
    id,
    url: `https://example.com/${id}`,
    secret: `secret_${id}`,
    events: ["transfer.minted"],
    ...overrides,
  };
}

describe("memory webhook endpoint store", () => {
  it("creates, reads, updates, and deletes an endpoint", async () => {
    const store = new MemoryWebhookEndpointStore();
    const record = endpoint("orders");

    expect(await store.create(record)).toBe(true);
    expect(await store.create(record)).toBe(false);

    const stored = await store.get("orders");
    expect(stored).toEqual(record);
    expect(stored).not.toBe(record);

    await store.put(endpoint("orders", { enabled: false }));
    expect((await store.get("orders"))?.enabled).toBe(false);

    await store.delete("orders");
    expect(await store.get("orders")).toBeUndefined();
  });

  it("clones the event filter", async () => {
    const store = new MemoryWebhookEndpointStore();
    const record = endpoint("orders");
    await store.create(record);

    (record.events as string[]).push("transfer.failed");

    expect((await store.get("orders"))?.events).toEqual(["transfer.minted"]);
  });

  it("lists endpoints by id", async () => {
    const store = new MemoryWebhookEndpointStore();
    await store.create(endpoint("b"));
    await store.create(endpoint("a"));

    expect((await store.list()).map((item) => item.id)).toEqual(["a", "b"]);
  });
});
