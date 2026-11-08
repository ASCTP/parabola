import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { TransferRecord, TransferStore } from "./contracts.js";

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
    const path = this.pathFor(record.idempotencyKey);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record, null, 2), "utf8");
      await rename(temporaryPath, path);
    } catch (err) {
      await unlink(temporaryPath).catch(() => undefined);
      throw err;
    }
  }

  async delete(idempotencyKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(idempotencyKey));
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }
}
