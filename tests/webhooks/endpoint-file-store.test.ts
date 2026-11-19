import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookEndpoint } from "../../src/webhooks/contracts.js";
import { FileWebhookEndpointStore } from "../../src/webhooks/endpoint-file-store.js";

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

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "parabola-webhook-endpoints-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file webhook endpoint store", () => {
  it("returns undefined for an unknown endpoint", async () => {
    const store = new FileWebhookEndpointStore(directory);

    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("creates an endpoint that survives reopening the store", async () => {
    const expected = endpoint("orders");
    const store = new FileWebhookEndpointStore(directory);

    await expect(store.create(expected)).resolves.toBe(true);
    await expect(
      new FileWebhookEndpointStore(directory).get("orders"),
    ).resolves.toEqual(expected);
  });

  it("does not overwrite an endpoint that already exists", async () => {
    const store = new FileWebhookEndpointStore(directory);
    await store.create(endpoint("orders"));

    await expect(
      store.create(endpoint("orders", { enabled: false })),
    ).resolves.toBe(false);
    await expect(store.get("orders")).resolves.toEqual(endpoint("orders"));
  });

  it("replaces an endpoint through an atomic temporary file", async () => {
    const store = new FileWebhookEndpointStore(directory);
    await store.create(endpoint("orders"));
    const updated = endpoint("orders", {
      url: "https://example.com/updated",
    });

    await store.put(updated);

    await expect(store.get("orders")).resolves.toEqual(updated);
    await expect(readdir(directory)).resolves.toEqual([
      `${encodeURIComponent("orders")}.json`,
    ]);
  });

  it("deletes an endpoint and treats a missing delete as a no-op", async () => {
    const store = new FileWebhookEndpointStore(directory);
    await store.create(endpoint("orders"));

    await store.delete("orders");

    await expect(store.get("orders")).resolves.toBeUndefined();
    await expect(store.delete("orders")).resolves.toBeUndefined();
  });

  it("encodes unsafe ids and creates nested directories", async () => {
    const nested = join(directory, "endpoints", "mainnet");
    const store = new FileWebhookEndpointStore(nested);
    const expected = endpoint("../orders:1?batch=a/b");

    await expect(store.create(expected)).resolves.toBe(true);

    await expect(store.get(expected.id)).resolves.toEqual(expected);
    await expect(readdir(nested)).resolves.toHaveLength(1);
  });

  it("lists endpoints by id across store instances", async () => {
    const store = new FileWebhookEndpointStore(directory);
    await store.create(endpoint("b"));
    await store.create(endpoint("a"));

    expect(
      (await new FileWebhookEndpointStore(directory).list()).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b"]);
  });
});
