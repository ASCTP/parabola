import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookDelivery } from "../../src/webhooks/contracts.js";
import { FileWebhookDeliveryStore } from "../../src/webhooks/file-store.js";

function delivery(
  id: string,
  overrides: Partial<WebhookDelivery> = {},
): WebhookDelivery {
  return {
    id,
    eventId: `evt_${id}`,
    endpointId: "endpoint_1",
    url: "https://example.com/hooks",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    event: {
      id: `evt_${id}`,
      type: "transfer.minted",
      createdAt: 1_000,
      data: { idempotencyKey: id },
    },
    ...overrides,
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "parabola-webhooks-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file webhook delivery store", () => {
  it("returns undefined for an unknown delivery", async () => {
    const store = new FileWebhookDeliveryStore(directory);

    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("creates a delivery that survives reopening the store", async () => {
    const expected = delivery("delivery_1");
    const store = new FileWebhookDeliveryStore(directory);

    await expect(store.create(expected)).resolves.toBe(true);
    await expect(
      new FileWebhookDeliveryStore(directory).get("delivery_1"),
    ).resolves.toEqual(expected);
  });

  it("does not overwrite a delivery that already exists", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(delivery("delivery_1"));

    await expect(
      store.create(
        delivery("delivery_1", {
          attempts: 4,
          status: "failed",
        }),
      ),
    ).resolves.toBe(false);
    await expect(store.get("delivery_1")).resolves.toEqual(
      delivery("delivery_1"),
    );
  });

  it("replaces a delivery through an atomic temporary file", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(delivery("delivery_1"));
    const updated = delivery("delivery_1", {
      status: "delivered",
      attempts: 1,
      updatedAt: 2_000,
      deliveredAt: 2_000,
    });

    await store.put(updated);

    await expect(store.get("delivery_1")).resolves.toEqual(updated);
    await expect(readdir(directory)).resolves.toEqual([
      `${encodeURIComponent("delivery_1")}.json`,
    ]);
  });

  it("deletes a delivery and treats a missing delete as a no-op", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(delivery("delivery_1"));

    await store.delete("delivery_1");

    await expect(store.get("delivery_1")).resolves.toBeUndefined();
    await expect(store.delete("delivery_1")).resolves.toBeUndefined();
  });

  it("encodes unsafe ids and creates nested directories", async () => {
    const nested = join(directory, "deliveries", "mainnet");
    const store = new FileWebhookDeliveryStore(nested);
    const expected = delivery("../delivery:1?batch=a/b");

    await expect(store.create(expected)).resolves.toBe(true);

    await expect(store.get(expected.id)).resolves.toEqual(expected);
    await expect(readdir(nested)).resolves.toHaveLength(1);
  });

  it("lists deliveries in due order across store instances", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(delivery("b", { nextAttemptAt: 2_000 }));
    await store.create(delivery("a", { nextAttemptAt: 1_000 }));

    expect(
      (await new FileWebhookDeliveryStore(directory).list()).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("lists only pending deliveries that are due", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(delivery("due", { nextAttemptAt: 1_000 }));
    await store.create(delivery("future", { nextAttemptAt: 3_000 }));
    await store.create(
      delivery("delivered", {
        status: "delivered",
        nextAttemptAt: 1_000,
      }),
    );

    expect((await store.listDue(2_000)).map((item) => item.id)).toEqual([
      "due",
    ]);
    expect(await store.listDue(2_000, 0)).toEqual([]);
  });

  it("lists failed deliveries in update order", async () => {
    const store = new FileWebhookDeliveryStore(directory);
    await store.create(
      delivery("later", {
        status: "failed",
        updatedAt: 2_000,
      }),
    );
    await store.create(
      delivery("earlier", {
        status: "failed",
        updatedAt: 1_000,
      }),
    );
    await store.create(delivery("pending"));

    expect((await store.listFailed()).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect((await store.listFailed(1)).map((item) => item.id)).toEqual([
      "earlier",
    ]);
  });

  it("rejects an invalid due limit", async () => {
    const store = new FileWebhookDeliveryStore(directory);

    await expect(store.listDue(1_000, -1)).rejects.toThrow(RangeError);
    await expect(store.listDue(1_000, 1.5)).rejects.toThrow(RangeError);
    await expect(store.listFailed(-1)).rejects.toThrow(RangeError);
  });
});
