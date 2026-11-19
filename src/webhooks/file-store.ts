import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { WebhookDelivery, WebhookDeliveryStore } from "./contracts.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isNotFound(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

function isAlreadyPresent(err: unknown): boolean {
  return isNodeError(err) && err.code === "EEXIST";
}

function sortDeliveries(a: WebhookDelivery, b: WebhookDelivery): number {
  return (
    a.nextAttemptAt - b.nextAttemptAt ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

function sortFailed(a: WebhookDelivery, b: WebhookDelivery): number {
  return a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
}

export class FileWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${encodeURIComponent(id)}.json`);
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

  async get(id: string): Promise<WebhookDelivery | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      return JSON.parse(raw) as WebhookDelivery;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<WebhookDelivery[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }

    const deliveries = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const id = decodeURIComponent(name.slice(0, -5));
          return this.get(id);
        }),
    );

    return deliveries
      .filter((delivery): delivery is WebhookDelivery => delivery !== undefined)
      .sort(sortDeliveries);
  }

  async listDue(now: number, limit?: number): Promise<WebhookDelivery[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("limit must be a non-negative integer");
    }
    const due = (await this.list()).filter(
      (delivery) =>
        delivery.status === "pending" && delivery.nextAttemptAt <= now,
    );
    return limit === undefined ? due : due.slice(0, limit);
  }

  async listFailed(limit?: number): Promise<WebhookDelivery[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("limit must be a non-negative integer");
    }
    const failed = (await this.list())
      .filter((delivery) => delivery.status === "failed")
      .sort(sortFailed);
    return limit === undefined ? failed : failed.slice(0, limit);
  }

  async create(delivery: WebhookDelivery): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(delivery.id);
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
      await handle.writeFile(JSON.stringify(delivery, null, 2), "utf8");
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw err;
    }
    await handle.close();
    return true;
  }

  async put(delivery: WebhookDelivery): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.writeJson(this.pathFor(delivery.id), delivery);
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.pathFor(id));
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }
}
