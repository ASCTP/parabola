import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileIndexerCursorStore,
  MemoryIndexerCursorStore,
  type IndexerCursor,
} from "../../src/indexer/cursor.js";
import { InvalidIndexerCursorError } from "../../src/indexer/errors.js";

const HASH = `0x${"a".repeat(64)}` as Hex;
const OTHER_HASH = `0x${"b".repeat(64)}` as Hex;

function cursor(overrides: Partial<IndexerCursor> = {}): IndexerCursor {
  return {
    stream: "arc:mainnet:burns",
    blockNumber: 100n,
    blockHash: HASH,
    updatedAt: 1,
    ...overrides,
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "parabola-cursor-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("MemoryIndexerCursorStore", () => {
  it("stores and retrieves a cursor", async () => {
    const store = new MemoryIndexerCursorStore();
    await store.put(cursor());

    expect(await store.get("arc:mainnet:burns")).toEqual(cursor());
  });

  it("returns copies rather than mutable internal state", async () => {
    const store = new MemoryIndexerCursorStore();
    await store.put(cursor());

    const first = await store.get("arc:mainnet:burns");
    if (!first) {
      throw new Error("expected cursor");
    }
    first.blockNumber = 999n;

    expect(await store.get("arc:mainnet:burns")).toEqual(cursor());
  });

  it("overwrites and deletes cursors", async () => {
    const store = new MemoryIndexerCursorStore();
    await store.put(cursor());
    await store.put(
      cursor({ blockNumber: 200n, blockHash: OTHER_HASH, updatedAt: 2 }),
    );

    expect(await store.get("arc:mainnet:burns")).toMatchObject({
      blockNumber: 200n,
      blockHash: OTHER_HASH,
    });

    await store.delete("arc:mainnet:burns");
    expect(await store.get("arc:mainnet:burns")).toBeUndefined();
  });

  it("returns undefined for an unknown stream", async () => {
    const store = new MemoryIndexerCursorStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("rejects invalid cursors", async () => {
    const store = new MemoryIndexerCursorStore();

    await expect(store.put(cursor({ stream: " " }))).rejects.toBeInstanceOf(
      InvalidIndexerCursorError,
    );
    await expect(
      store.put(cursor({ blockNumber: -1n })),
    ).rejects.toBeInstanceOf(InvalidIndexerCursorError);
    await expect(
      store.put(cursor({ blockHash: "0x1234" })),
    ).rejects.toBeInstanceOf(InvalidIndexerCursorError);
    await expect(
      store.put(cursor({ updatedAt: Number.NaN })),
    ).rejects.toBeInstanceOf(InvalidIndexerCursorError);
  });
});

describe("FileIndexerCursorStore", () => {
  it("persists a cursor across store instances", async () => {
    const first = new FileIndexerCursorStore(directory);
    await first.put(cursor());

    const second = new FileIndexerCursorStore(directory);
    expect(await second.get("arc:mainnet:burns")).toEqual(cursor());
  });

  it("stores the block number as a decimal string", async () => {
    const store = new FileIndexerCursorStore(directory);
    await store.put(cursor());

    const [file] = await readdir(directory);
    if (!file) {
      throw new Error("expected cursor file");
    }
    const raw = JSON.parse(
      await readFile(join(directory, file), "utf8"),
    ) as { blockNumber: string };

    expect(raw.blockNumber).toBe("100");
  });

  it("encodes stream names into safe file names", async () => {
    const store = new FileIndexerCursorStore(directory);
    await store.put(cursor());

    expect(await readdir(directory)).toEqual([
      "arc%3Amainnet%3Aburns.cursor.json",
    ]);
  });

  it("overwrites and deletes cursors", async () => {
    const store = new FileIndexerCursorStore(directory);
    await store.put(cursor());
    await store.put(
      cursor({ blockNumber: 200n, blockHash: OTHER_HASH, updatedAt: 2 }),
    );

    expect(await store.get("arc:mainnet:burns")).toMatchObject({
      blockNumber: 200n,
      blockHash: OTHER_HASH,
    });

    await store.delete("arc:mainnet:burns");
    expect(await store.get("arc:mainnet:burns")).toBeUndefined();
    await expect(store.delete("arc:mainnet:burns")).resolves.toBeUndefined();
  });

  it("returns undefined for an unknown stream", async () => {
    const store = new FileIndexerCursorStore(directory);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("rejects invalid cursors without writing a file", async () => {
    const store = new FileIndexerCursorStore(directory);

    await expect(
      store.put(cursor({ blockHash: "0x1234" })),
    ).rejects.toBeInstanceOf(InvalidIndexerCursorError);
    expect(await readdir(directory)).toEqual([]);
  });
});
