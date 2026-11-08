import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { FileTransferStore } from "../../src/execution/file-store.js";

const RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

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

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "parabola-execution-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file transfer store", () => {
  it("returns undefined for an unknown key", async () => {
    const store = new FileTransferStore(directory);

    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("creates a record that survives reopening the store", async () => {
    const expected = record();
    const store = new FileTransferStore(directory);

    await expect(store.create(expected)).resolves.toBe(true);
    await expect(new FileTransferStore(directory).get("order-1")).resolves.toEqual(
      expected,
    );
  });

  it("does not overwrite a record that already exists", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());

    await expect(
      store.create(record({ amount: "99", phase: "minted" })),
    ).resolves.toBe(false);
    await expect(store.get("order-1")).resolves.toEqual(record());
  });

  it("replaces a record through an atomic temporary file", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());
    const updated = record({ phase: "minted", amount: "42" });

    await store.put(updated);

    await expect(store.get("order-1")).resolves.toEqual(updated);
    await expect(readdir(directory)).resolves.toEqual([
      `${encodeURIComponent("order-1")}.json`,
    ]);
  });

  it("deletes a record and treats a missing delete as a no-op", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());

    await store.delete("order-1");

    await expect(store.get("order-1")).resolves.toBeUndefined();
    await expect(store.delete("order-1")).resolves.toBeUndefined();
  });

  it("encodes unsafe keys and creates nested directories", async () => {
    const nested = join(directory, "records", "mainnet");
    const store = new FileTransferStore(nested);
    const expected = record({ idempotencyKey: "../order:1?batch=a/b" });

    await expect(store.create(expected)).resolves.toBe(true);

    await expect(store.get(expected.idempotencyKey)).resolves.toEqual(expected);
    await expect(readdir(nested)).resolves.toHaveLength(1);
  });

  it("allows exactly one concurrent create for the same key", async () => {
    const store = new FileTransferStore(directory);

    const outcomes = await Promise.all([
      store.create(record({ amount: "1" })),
      store.create(record({ amount: "2" })),
    ]);

    expect(outcomes.sort()).toEqual([false, true]);
    const stored = await store.get("order-1");
    expect(["1", "2"]).toContain(stored?.amount);
  });

  it("propagates a malformed record instead of hiding it", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());
    const path = join(directory, `${encodeURIComponent("order-1")}.json`);
    await writeFile(path, "{", "utf8");

    await expect(store.get("order-1")).rejects.toBeInstanceOf(SyntaxError);
  });
});
