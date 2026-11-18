import { describe, expect, it } from "vitest";
import type { WebhookDelivery } from "../../src/webhooks/contracts.js";
import { MemoryWebhookDeliveryStore } from "../../src/webhooks/memory-store.js";

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

describe("memory webhook delivery store", () => {
  it("creates, reads, updates, and deletes a delivery", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const record = delivery("delivery_1");

    expect(await store.create(record)).toBe(true);
    expect(await store.create(record)).toBe(false);

    const stored = await store.get("delivery_1");
    expect(stored).toEqual(record);
    expect(stored).not.toBe(record);

    await store.put({
      ...record,
      status: "delivered",
      attempts: 1,
      updatedAt: 2_000,
    });
    expect((await store.get("delivery_1"))?.status).toBe("delivered");

    await store.delete("delivery_1");
    expect(await store.get("delivery_1")).toBeUndefined();
  });

  it("clones nested event data", async () => {
    const store = new MemoryWebhookDeliveryStore();
    const record = delivery("delivery_1", {
      event: {
        id: "evt_1",
        type: "transfer.minted",
        createdAt: 1_000,
        data: { nested: { value: 1 } },
      },
    });
    await store.create(record);

    const first = await store.get("delivery_1");
    (first?.event.data as { nested: { value: number } }).nested.value = 2;

    const second = await store.get("delivery_1");
    expect(
      (second?.event.data as { nested: { value: number } }).nested
        .value,
    ).toBe(1);
  });

  it("lists deliveries in due order", async () => {
    const store = new MemoryWebhookDeliveryStore();
    await store.create(delivery("b", { nextAttemptAt: 2_000 }));
    await store.create(delivery("a", { nextAttemptAt: 1_000 }));
    await store.create(delivery("c", { nextAttemptAt: 1_000 }));

    expect((await store.list()).map((item) => item.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("lists only pending deliveries that are due", async () => {
    const store = new MemoryWebhookDeliveryStore();
    await store.create(delivery("due", { nextAttemptAt: 1_000 }));
    await store.create(delivery("future", { nextAttemptAt: 3_000 }));
    await store.create(
      delivery("delivered", {
        status: "delivered",
        nextAttemptAt: 1_000,
      }),
    );

    expect(
      (await store.listDue(2_000)).map((item) => item.id),
    ).toEqual(["due"]);
    expect(
      (await store.listDue(2_000, 0)).map((item) => item.id),
    ).toEqual([]);
  });

  it("lists failed deliveries in update order", async () => {
    const store = new MemoryWebhookDeliveryStore();
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

    expect(
      (await store.listFailed()).map((item) => item.id),
    ).toEqual(["earlier", "later"]);
    expect(
      (await store.listFailed(1)).map((item) => item.id),
    ).toEqual(["earlier"]);
  });

  it("rejects an invalid due limit", async () => {
    const store = new MemoryWebhookDeliveryStore();

    await expect(store.listDue(1_000, -1)).rejects.toThrow(
      RangeError,
    );
    await expect(store.listDue(1_000, 1.5)).rejects.toThrow(
      RangeError,
    );
    await expect(store.listFailed(-1)).rejects.toThrow(RangeError);
  });
});
