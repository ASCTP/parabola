import { describe, expect, it } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "planned",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("memory transfer store leases", () => {
  it("lists records in creation order", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ idempotencyKey: "order-2", createdAt: 2 }));
    await store.create(record({ idempotencyKey: "order-1", createdAt: 1 }));

    await expect(store.list()).resolves.toMatchObject([
      { idempotencyKey: "order-1" },
      { idempotencyKey: "order-2" },
    ]);
  });

  it("claims a key and blocks another owner", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());

    await expect(
      store.claim("order-1", "owner-a", 60_000),
    ).resolves.toMatchObject({
      status: "claimed",
      record: { idempotencyKey: "order-1" },
    });
    await expect(
      store.claim("order-1", "owner-b", 60_000),
    ).resolves.toMatchObject({
      status: "busy",
      record: { idempotencyKey: "order-1" },
    });
  });

  it("lets the same owner renew its lease", async () => {
    const store = new MemoryTransferStore();
    await store.claim("order-1", "owner-a", 60_000);

    await expect(store.renew("order-1", "owner-a", 60_000)).resolves.toBe(true);
    await expect(store.renew("order-1", "owner-b", 60_000)).resolves.toBe(
      false,
    );
  });

  it("releases a lease for another owner", async () => {
    const store = new MemoryTransferStore();
    await store.claim("order-1", "owner-a", 60_000);

    await store.release("order-1", "owner-b");

    await expect(
      store.claim("order-1", "owner-b", 60_000),
    ).resolves.toMatchObject({ status: "busy" });
    await store.release("order-1", "owner-a");
    await expect(
      store.claim("order-1", "owner-b", 60_000),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  it("reclaims an expired lease", async () => {
    const store = new MemoryTransferStore();
    await store.claim("order-1", "owner-a", 0);

    await expect(
      store.claim("order-1", "owner-b", 60_000),
    ).resolves.toMatchObject({ status: "claimed" });
    await expect(store.renew("order-1", "owner-a", 60_000)).resolves.toBe(
      false,
    );
  });

  it("removes the lease when a record is deleted", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    await store.claim("order-1", "owner-a", 60_000);

    await store.delete("order-1");

    await expect(store.claim("order-1", "owner-b", 60_000)).resolves.toEqual({
      status: "claimed",
    });
  });
});
