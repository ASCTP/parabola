import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  TransferClaim,
  TransferLease,
  TransferRecord,
  TransferStore,
} from "./contracts.js";

const LEASE_LOCK_STALE_MS = 5_000;
const LEASE_LOCK_RETRY_MS = 10;
const LEASE_LOCK_ATTEMPTS = 200;

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isNotFound(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

function isAlreadyPresent(err: unknown): boolean {
  return isNodeError(err) && err.code === "EEXIST";
}

export class FileTransferStore implements TransferStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(idempotencyKey: string): string {
    return join(this.directory, `${encodeURIComponent(idempotencyKey)}.json`);
  }

  private leasePathFor(idempotencyKey: string): string {
    return join(this.directory, `${encodeURIComponent(idempotencyKey)}.lease`);
  }

  private lockPath(): string {
    return join(this.directory, ".lease.lock");
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
      await rename(temporaryPath, path);
    } catch (err) {
      await unlink(temporaryPath).catch(() => undefined);
      throw err;
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }

  private async readLease(
    idempotencyKey: string,
  ): Promise<TransferLease | undefined> {
    try {
      const raw = await readFile(this.leasePathFor(idempotencyKey), "utf8");
      return JSON.parse(raw) as TransferLease;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  private async withLeaseLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = this.lockPath();

    for (let attempt = 0; attempt < LEASE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockPath);
      } catch (err) {
        if (!isAlreadyPresent(err)) {
          throw err;
        }
        let stale = false;
        try {
          const info = await stat(lockPath);
          stale = Date.now() - info.mtimeMs > LEASE_LOCK_STALE_MS;
        } catch (statErr) {
          if (isNotFound(statErr)) {
            continue;
          }
          throw statErr;
        }
        if (stale) {
          try {
            await rmdir(lockPath);
          } catch (removeErr) {
            if (!isNotFound(removeErr)) {
              throw removeErr;
            }
          }
          continue;
        }
        await delay(LEASE_LOCK_RETRY_MS);
        continue;
      }

      try {
        return await fn();
      } finally {
        await rmdir(lockPath).catch(() => undefined);
      }
    }

    throw new Error("Timed out acquiring the transfer lease lock");
  }

  async get(idempotencyKey: string): Promise<TransferRecord | undefined> {
    try {
      const raw = await readFile(this.pathFor(idempotencyKey), "utf8");
      return JSON.parse(raw) as TransferRecord;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<TransferRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }

    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const idempotencyKey = decodeURIComponent(name.slice(0, -5));
          return this.get(idempotencyKey);
        }),
    );

    return records
      .filter((record): record is TransferRecord => record !== undefined)
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.idempotencyKey.localeCompare(b.idempotencyKey),
      );
  }

  async create(record: TransferRecord): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(record.idempotencyKey);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if (isAlreadyPresent(err)) {
        return false;
      }
      throw err;
    }

    try {
      await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw err;
    }
    await handle.close();
    return true;
  }

  async put(record: TransferRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.writeJson(this.pathFor(record.idempotencyKey), record);
  }

  async delete(idempotencyKey: string): Promise<void> {
    await this.withLeaseLock(async () => {
      await this.unlinkIfPresent(this.pathFor(idempotencyKey));
      await this.unlinkIfPresent(this.leasePathFor(idempotencyKey));
    });
  }

  async claim(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<TransferClaim> {
    return this.withLeaseLock(async () => {
      const now = Date.now();
      const lease = await this.readLease(idempotencyKey);
      const record = await this.get(idempotencyKey);
      if (lease && lease.expiresAt > now && lease.owner !== owner) {
        return { status: "busy", record };
      }
      await this.writeJson(this.leasePathFor(idempotencyKey), {
        owner,
        expiresAt: now + leaseMs,
      });
      return record ? { status: "claimed", record } : { status: "claimed" };
    });
  }

  async renew(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean> {
    return this.withLeaseLock(async () => {
      const now = Date.now();
      const lease = await this.readLease(idempotencyKey);
      if (!lease || lease.owner !== owner || lease.expiresAt <= now) {
        return false;
      }
      await this.writeJson(this.leasePathFor(idempotencyKey), {
        owner,
        expiresAt: now + leaseMs,
      });
      return true;
    });
  }

  async release(idempotencyKey: string, owner: string): Promise<void> {
    await this.withLeaseLock(async () => {
      const lease = await this.readLease(idempotencyKey);
      if (lease?.owner === owner) {
        await this.unlinkIfPresent(this.leasePathFor(idempotencyKey));
      }
    });
  }
}
