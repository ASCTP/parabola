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
import type {
  WebhookEndpoint,
  WebhookEndpointStore,
} from "./contracts.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isNotFound(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

function isAlreadyPresent(err: unknown): boolean {
  return isNodeError(err) && err.code === "EEXIST";
}

export class FileWebhookEndpointStore implements WebhookEndpointStore {
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

  async get(id: string): Promise<WebhookEndpoint | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      return JSON.parse(raw) as WebhookEndpoint;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<WebhookEndpoint[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }

    const endpoints = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const id = decodeURIComponent(name.slice(0, -5));
          return this.get(id);
        }),
    );

    return endpoints
      .filter(
        (endpoint): endpoint is WebhookEndpoint =>
          endpoint !== undefined,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async create(endpoint: WebhookEndpoint): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(endpoint.id);
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
      await handle.writeFile(JSON.stringify(endpoint, null, 2), "utf8");
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw err;
    }
    await handle.close();
    return true;
  }

  async put(endpoint: WebhookEndpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.writeJson(this.pathFor(endpoint.id), endpoint);
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
