import { describe, expect, it } from "vitest";
import type { WebhookEndpoint } from "../../src/webhooks/contracts.js";
import { MemoryWebhookEndpointStore } from "../../src/webhooks/endpoint-memory-store.js";
import { WebhookEndpointManager } from "../../src/webhooks/endpoint-manager.js";
import {
  WebhookConfigurationError,
  WebhookEndpointConflictError,
  WebhookEndpointNotFoundError,
} from "../../src/webhooks/errors.js";

function endpoint(
  id: string,
  overrides: Partial<WebhookEndpoint> = {},
): WebhookEndpoint {
  return {
    id,
    url: `https://example.com/${id}`,
    secret: `secret_${id}`,
    ...overrides,
  };
}

describe("webhook endpoint manager", () => {
  it("creates, lists, reads, updates, and removes endpoints", async () => {
    const manager = new WebhookEndpointManager(
      new MemoryWebhookEndpointStore(),
    );

    await manager.create(endpoint("orders"));
    await manager.create(endpoint("audit"));

    expect((await manager.list()).map((item) => item.id)).toEqual([
      "audit",
      "orders",
    ]);
    expect(await manager.get("orders")).toEqual(endpoint("orders"));

    await manager.update(
      endpoint("orders", { enabled: false }),
    );
    expect((await manager.get("orders"))?.enabled).toBe(false);

    await manager.remove("orders");
    expect(await manager.get("orders")).toBeUndefined();
  });

  it("rejects a duplicate endpoint", async () => {
    const manager = new WebhookEndpointManager(
      new MemoryWebhookEndpointStore(),
    );
    await manager.create(endpoint("orders"));

    await expect(
      manager.create(endpoint("orders")),
    ).rejects.toThrow(WebhookEndpointConflictError);
  });

  it("rejects updates and removals for missing endpoints", async () => {
    const manager = new WebhookEndpointManager(
      new MemoryWebhookEndpointStore(),
    );

    await expect(
      manager.update(endpoint("missing")),
    ).rejects.toThrow(WebhookEndpointNotFoundError);
    await expect(
      manager.remove("missing"),
    ).rejects.toThrow(WebhookEndpointNotFoundError);
  });

  it("rejects invalid endpoints before storing them", async () => {
    const manager = new WebhookEndpointManager(
      new MemoryWebhookEndpointStore(),
    );

    await expect(
      manager.create(endpoint("orders", { secret: "" })),
    ).rejects.toThrow(WebhookConfigurationError);
    await expect(
      manager.create(endpoint("orders", { url: "not a url" })),
    ).rejects.toThrow(/valid URL/);
  });

  it("rejects invalid endpoints already present in the store", async () => {
    const store = new MemoryWebhookEndpointStore();
    await store.put(endpoint("orders", { secret: "" }));
    const manager = new WebhookEndpointManager(store);

    await expect(manager.list()).rejects.toThrow(
      /secret must not be empty/,
    );
    await expect(manager.get("orders")).rejects.toThrow(
      /secret must not be empty/,
    );
  });
});
