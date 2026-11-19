import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TransferRecord, TransferStore } from "./execution/contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferLeaseLostError,
  TransferNotFoundError,
} from "./execution/errors.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  HttpRequestError,
  readJson,
  requireObject,
  requiredBigInt,
  requiredNumber,
  requiredPositiveInteger,
  requiredString,
  sendJson,
} from "./http-json.js";
import type { IndexerCursor, IndexerCursorStore } from "./indexer/cursor.js";
import {
  IndexerCursorError,
  InvalidIndexerCursorError,
} from "./indexer/errors.js";
import type { SettlementMetrics } from "./observability.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;

export interface StoreServerOptions {
  transferStore: TransferStore;
  cursorStore?: IndexerCursorStore;
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  metrics?: SettlementMetrics;
  onRequest?: (event: StoreRequestEvent) => void;
}

export interface StoreRequestEvent {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface StoreAddress {
  host: string;
  port: number;
  url: string;
}

export interface StoreServer {
  readonly server: Server;
  listen(): Promise<StoreAddress>;
  close(): Promise<void>;
}

function statusFor(error: unknown): number {
  if (error instanceof HttpRequestError) {
    return error.status;
  }
  if (error instanceof TransferNotFoundError) {
    return 404;
  }
  if (
    error instanceof TransferConflictError ||
    error instanceof TransferLeaseLostError ||
    error instanceof IndexerCursorError
  ) {
    return 409;
  }
  if (
    error instanceof InvalidIdempotencyKeyError ||
    error instanceof InvalidIndexerCursorError ||
    error instanceof RangeError
  ) {
    return 400;
  }
  return 500;
}

function messageFor(error: unknown): string {
  if (statusFor(error) === 500) {
    return "Internal server error";
  }
  return error instanceof Error ? error.message : String(error);
}

function routeFor(path: string): string {
  if (path === "/health" || path === "/transfers") {
    return path;
  }
  const actionMatch = /^\/transfers\/[^/]+\/(claim|renew|release)$/.exec(path);
  if (actionMatch) {
    return `/transfers/:idempotencyKey/${actionMatch[1] as string}`;
  }
  if (/^\/transfers\/[^/]+$/.test(path)) {
    return "/transfers/:idempotencyKey";
  }
  if (/^\/cursors\/[^/]+$/.test(path)) {
    return "/cursors/:stream";
  }
  return "unknown";
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    ).pathname;
  } catch {
    return "/";
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpRequestError(400, "Invalid path encoding");
  }
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: "Method not allowed" });
}

function sendNoContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function requireTransferRecord(body: Record<string, unknown>): TransferRecord {
  const idempotencyKey = requiredString(body, "idempotencyKey");
  const createdAt = requiredNumber(body, "createdAt");
  const updatedAt = requiredNumber(body, "updatedAt");
  return {
    ...body,
    idempotencyKey,
    createdAt,
    updatedAt,
  } as TransferRecord;
}

function requireCursor(body: Record<string, unknown>): IndexerCursor {
  return {
    stream: requiredString(body, "stream"),
    blockNumber: requiredBigInt(body, "blockNumber"),
    blockHash: requiredString(body, "blockHash") as IndexerCursor["blockHash"],
    updatedAt: requiredNumber(body, "updatedAt"),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: StoreServerOptions,
): Promise<void> {
  const path = requestPath(request);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (path === "/health") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return;
    }
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (
    options.token !== undefined &&
    request.headers.authorization !== `Bearer ${options.token}`
  ) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  if (path === "/transfers") {
    if (request.method === "GET") {
      sendJson(response, 200, {
        transfers: await options.transferStore.list(),
      });
      return;
    }
    if (request.method === "POST") {
      const record = requireTransferRecord(
        requireObject(await readJson(request, maxBodyBytes)),
      );
      const created = await options.transferStore.create(record);
      sendJson(response, 200, { created });
      return;
    }
    methodNotAllowed(response);
    return;
  }

  const actionMatch = /^\/transfers\/([^/]+)\/(claim|renew|release)$/.exec(
    path,
  );
  if (actionMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }
    const idempotencyKey = decodeSegment(actionMatch[1] as string);
    const action = actionMatch[2] as "claim" | "renew" | "release";
    const body = requireObject(await readJson(request, maxBodyBytes));

    if (action === "claim") {
      const claim = await options.transferStore.claim(
        idempotencyKey,
        requiredString(body, "owner"),
        requiredPositiveInteger(body, "leaseMs"),
      );
      sendJson(response, 200, claim);
      return;
    }

    if (action === "renew") {
      const renewed = await options.transferStore.renew(
        idempotencyKey,
        requiredString(body, "owner"),
        requiredPositiveInteger(body, "leaseMs"),
      );
      sendJson(response, 200, { renewed });
      return;
    }

    await options.transferStore.release(
      idempotencyKey,
      requiredString(body, "owner"),
    );
    sendNoContent(response);
    return;
  }

  const transferMatch = /^\/transfers\/([^/]+)$/.exec(path);
  if (transferMatch) {
    const idempotencyKey = decodeSegment(transferMatch[1] as string);

    if (request.method === "GET") {
      const record = await options.transferStore.get(idempotencyKey);
      if (!record) {
        throw new TransferNotFoundError(idempotencyKey);
      }
      sendJson(response, 200, { transfer: record });
      return;
    }

    if (request.method === "PUT") {
      const record = requireTransferRecord(
        requireObject(await readJson(request, maxBodyBytes)),
      );
      if (record.idempotencyKey !== idempotencyKey) {
        throw new HttpRequestError(
          400,
          "idempotencyKey must match the request path",
        );
      }
      await options.transferStore.put(record);
      sendNoContent(response);
      return;
    }

    if (request.method === "DELETE") {
      await options.transferStore.delete(idempotencyKey);
      sendNoContent(response);
      return;
    }

    methodNotAllowed(response);
    return;
  }

  const cursorMatch = /^\/cursors\/([^/]+)$/.exec(path);
  if (cursorMatch) {
    if (!options.cursorStore) {
      sendJson(response, 501, {
        error: "Cursor store is not configured",
      });
      return;
    }
    const stream = decodeSegment(cursorMatch[1] as string);

    if (request.method === "GET") {
      const cursor = await options.cursorStore.get(stream);
      if (!cursor) {
        throw new HttpRequestError(
          404,
          `Indexer cursor ${stream} was not found`,
        );
      }
      sendJson(response, 200, { cursor });
      return;
    }

    if (request.method === "PUT") {
      const cursor = requireCursor(
        requireObject(await readJson(request, maxBodyBytes)),
      );
      if (cursor.stream !== stream) {
        throw new HttpRequestError(400, "stream must match the request path");
      }
      await options.cursorStore.put(cursor);
      sendNoContent(response);
      return;
    }

    if (request.method === "DELETE") {
      await options.cursorStore.delete(stream);
      sendNoContent(response);
      return;
    }

    methodNotAllowed(response);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createStoreServer(options: StoreServerOptions): StoreServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer((request, response) => {
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const route = routeFor(requestPath(request));

    const observe = () => {
      const status = response.statusCode;
      const durationMs = Date.now() - startedAt;
      options.metrics?.counter("parabola_store_requests_total", 1, {
        method,
        route,
        status: String(status),
      });
      options.metrics?.histogram(
        "parabola_store_request_duration_ms",
        durationMs,
        {
          method,
          route,
          status: String(status),
        },
      );
      options.onRequest?.({ method, route, status, durationMs });
    };

    void handle(request, response, options).then(observe, (error) => {
      if (response.headersSent) {
        response.destroy();
        observe();
        return;
      }
      sendJson(response, statusFor(error), {
        error: messageFor(error),
      });
      observe();
    });
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (typeof address !== "object" || address === null) {
            reject(new Error("Store server did not expose a TCP address"));
            return;
          }
          resolve({
            host: address.address,
            port: address.port,
            url: `http://${address.address}:${address.port}`,
          });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
