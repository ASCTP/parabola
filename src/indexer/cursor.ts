import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hex } from "viem";
import { InvalidIndexerCursorError } from "./errors.js";

export interface IndexerCursor {
  stream: string;
  blockNumber: bigint;
  blockHash: Hex;
  updatedAt: number;
}

export interface IndexerCursorStore {
  get(stream: string): Promise<IndexerCursor | undefined>;
  put(cursor: IndexerCursor): Promise<void>;
  delete(stream: string): Promise<void>;
}

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

function validate(cursor: IndexerCursor): void {
  if (cursor.stream.trim() === "") {
    throw new InvalidIndexerCursorError("stream must be a non-empty string");
  }
  if (cursor.blockNumber < 0n) {
    throw new InvalidIndexerCursorError("blockNumber must not be negative");
  }
  if (!BLOCK_HASH.test(cursor.blockHash)) {
    throw new InvalidIndexerCursorError(
      "blockHash must be a 32-byte hex string",
    );
  }
  if (!Number.isFinite(cursor.updatedAt) || cursor.updatedAt < 0) {
    throw new InvalidIndexerCursorError(
      "updatedAt must be a non-negative finite number",
    );
  }
}

function clone(cursor: IndexerCursor): IndexerCursor {
  return { ...cursor };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isNotFound(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

export class MemoryIndexerCursorStore implements IndexerCursorStore {
  private readonly cursors = new Map<string, IndexerCursor>();

  async get(stream: string): Promise<IndexerCursor | undefined> {
    const cursor = this.cursors.get(stream);
    return cursor ? clone(cursor) : undefined;
  }

  async put(cursor: IndexerCursor): Promise<void> {
    validate(cursor);
    this.cursors.set(cursor.stream, clone(cursor));
  }

  async delete(stream: string): Promise<void> {
    this.cursors.delete(stream);
  }
}

interface StoredCursor {
  stream: string;
  blockNumber: string;
  blockHash: Hex;
  updatedAt: number;
}

export class FileIndexerCursorStore implements IndexerCursorStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(stream: string): string {
    return join(this.directory, `${encodeURIComponent(stream)}.cursor.json`);
  }

  async get(stream: string): Promise<IndexerCursor | undefined> {
    try {
      const raw = await readFile(this.pathFor(stream), "utf8");
      const stored = JSON.parse(raw) as StoredCursor;
      return {
        stream: stored.stream,
        blockNumber: BigInt(stored.blockNumber),
        blockHash: stored.blockHash,
        updatedAt: stored.updatedAt,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async put(cursor: IndexerCursor): Promise<void> {
    validate(cursor);
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(cursor.stream);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const stored: StoredCursor = {
      stream: cursor.stream,
      blockNumber: cursor.blockNumber.toString(),
      blockHash: cursor.blockHash,
      updatedAt: cursor.updatedAt,
    };
    try {
      await writeFile(temporaryPath, JSON.stringify(stored, null, 2), "utf8");
      await rename(temporaryPath, path);
    } catch (err) {
      await unlink(temporaryPath).catch(() => undefined);
      throw err;
    }
  }

  async delete(stream: string): Promise<void> {
    try {
      await unlink(this.pathFor(stream));
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }
}
