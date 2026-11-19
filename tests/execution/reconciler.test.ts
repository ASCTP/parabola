import { describe, expect, it } from "vitest";
import type {
  TransferRecord,
  TransferStore,
} from "../../src/execution/contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferEvidenceError,
  TransferNotFoundError,
  TransferPersistenceError,
} from "../../src/execution/errors.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import { reconcileTransfer } from "../../src/execution/reconciler.js";

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "burning",
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

function failingStore(): TransferStore {
  const inner = new MemoryTransferStore();
  return {
    get: (key) => inner.get(key),
    list: () => inner.list(),
    create: (value) => inner.create(value),
    delete: (key) => inner.delete(key),
    claim: (key, owner, leaseMs) => inner.claim(key, owner, leaseMs),
    renew: (key, owner, leaseMs) => inner.renew(key, owner, leaseMs),
    release: (key, owner) => inner.release(key, owner),
    async put() {
      throw new Error("disk full");
    },
  };
}

describe("transfer reconciler", () => {
  it("rejects a blank idempotency key before touching the store", async () => {
    const store = new MemoryTransferStore();

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "   ",
        evidence: { burnTxHash: "burn-1" },
      }),
    ).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
  });

  it("requires a burn or mint transaction hash", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { attestationHash: "0xattestation" },
      }),
    ).rejects.toBeInstanceOf(TransferEvidenceError);
  });

  it("rejects an unknown transfer and releases the claim", async () => {
    const store = new MemoryTransferStore();

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "missing",
        evidence: { burnTxHash: "burn-1" },
      }),
    ).rejects.toBeInstanceOf(TransferNotFoundError);

    await expect(store.claim("missing", "other-owner", 1_000)).resolves.toEqual(
      {
        status: "claimed",
      },
    );
  });

  it("promotes a burning transfer with observed burn evidence", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({ phase: "burning", error: "burn submission timed out" }),
    );

    const outcome = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: {
        burnTxHash: "  burn-1  ",
        attestationHash: " 0xattestation ",
      },
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.record).toMatchObject({
      phase: "burned",
      burnTxHash: "burn-1",
      attestationHash: "0xattestation",
    });
    expect(outcome.record.error).toBeUndefined();
    expect(outcome.record.updatedAt).toBeGreaterThan(1);
    await expect(store.get("order-1")).resolves.toEqual(outcome.record);
  });

  it("attaches burn evidence without downgrading a minting transfer", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "minting" }));

    const outcome = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: { burnTxHash: "burn-1" },
    });

    expect(outcome.record.phase).toBe("minting");
    expect(outcome.record.burnTxHash).toBe("burn-1");
  });

  it("rejects burn evidence that conflicts with the stored hash", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "burned", burnTxHash: "burn-1" }));

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { burnTxHash: "burn-2" },
      }),
    ).rejects.toBeInstanceOf(TransferEvidenceError);
  });

  it("marks a minting transfer minted with observed mint evidence", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({
        phase: "minting",
        burnTxHash: "burn-1",
        attestationHash: "0xattestation",
        transferMode: "fast",
        fee: "0.01",
        error: "mint confirmation timed out",
      }),
    );

    const outcome = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: { mintTxHash: "  mint-1 " },
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.result).toMatchObject({
      status: "success",
      transferMode: "fast",
      burnTxHash: "burn-1",
      attestationHash: "0xattestation",
      mintTxHash: "mint-1",
      fee: "0.01",
    });
    expect(outcome.record.phase).toBe("minted");
    expect(outcome.record.mintTxHash).toBe("mint-1");
    expect(outcome.record.error).toBeUndefined();
    await expect(store.get("order-1")).resolves.toEqual(outcome.record);
  });

  it("requires a burn hash before accepting mint evidence", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "minting" }));

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { mintTxHash: "mint-1" },
      }),
    ).rejects.toBeInstanceOf(TransferEvidenceError);
  });

  it("accepts burn and mint evidence together for a burning transfer", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "burning" }));

    const outcome = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: {
        burnTxHash: "burn-1",
        attestationHash: "0xattestation",
        mintTxHash: "mint-1",
      },
    });

    expect(outcome.record.phase).toBe("minted");
    expect(outcome.record.burnTxHash).toBe("burn-1");
    expect(outcome.record.attestationHash).toBe("0xattestation");
    expect(outcome.record.mintTxHash).toBe("mint-1");
    expect(outcome.result?.mintTxHash).toBe("mint-1");
  });

  it("rejects mint evidence that conflicts with the stored hash", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({
        phase: "minted",
        burnTxHash: "burn-1",
        mintTxHash: "mint-1",
      }),
    );

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { mintTxHash: "mint-2" },
      }),
    ).rejects.toBeInstanceOf(TransferEvidenceError);
  });

  it("reports an unchanged transfer when evidence already matches", async () => {
    const store = new MemoryTransferStore();
    const existing = record({
      phase: "minted",
      burnTxHash: "burn-1",
      attestationHash: "0xattestation",
      mintTxHash: "mint-1",
    });
    await store.create(existing);

    const outcome = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: { mintTxHash: "mint-1" },
    });

    expect(outcome.changed).toBe(false);
    expect(outcome.record).toEqual(existing);
    expect(outcome.result).toMatchObject({
      status: "success",
      burnTxHash: "burn-1",
      mintTxHash: "mint-1",
    });
  });

  it("refuses to reconcile failed transfers", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "failed" }));

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { burnTxHash: "burn-1" },
      }),
    ).rejects.toBeInstanceOf(TransferEvidenceError);
  });

  it("reports a busy lease as an in-progress conflict", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "minting" }));
    await store.claim("order-1", "other-owner", 60_000);

    const err = await reconcileTransfer(store, {
      idempotencyKey: "order-1",
      evidence: { mintTxHash: "mint-1" },
    }).catch((error) => error);

    expect(err).toBeInstanceOf(TransferConflictError);
    expect((err as TransferConflictError).reason).toBe("in_progress");
  });

  it("wraps persistence failures", async () => {
    const store = failingStore();
    await store.create(record());

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { burnTxHash: "burn-1" },
      }),
    ).rejects.toBeInstanceOf(TransferPersistenceError);
  });

  it("releases the lease after a persistence failure", async () => {
    const store = failingStore();
    await store.create(record());

    await expect(
      reconcileTransfer(store, {
        idempotencyKey: "order-1",
        evidence: { burnTxHash: "burn-1" },
      }),
    ).rejects.toBeInstanceOf(TransferPersistenceError);

    await expect(
      store.claim("order-1", "other-owner", 1_000),
    ).resolves.toMatchObject({
      status: "claimed",
    });
  });
});
