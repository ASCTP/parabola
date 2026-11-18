import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TransferStore } from "./execution/contracts.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  HttpRequestError,
  optionalBigInt,
  optionalString,
  readJson,
  requireObject,
  requiredBigInt,
  requiredNumber,
  requiredString,
  sendJson,
} from "./http-json.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferEvidenceError,
  TransferLeaseLostError,
  TransferNotFoundError,
} from "./execution/errors.js";
import type { IndexerCursorStore } from "./indexer/cursor.js";
import {
  IndexerCursorError,
  InvalidIndexerRangeError,
  InvalidLedgerRangeError,
} from "./indexer/errors.js";
import type { SettlementMetrics } from "./observability.js";
import {
  createSettlementRuntime,
  type SettlementRuntime,
} from "./runtime.js";
import type { Network } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

export type ApiRuntime = Pick<
  SettlementRuntime,
  | "reconcile"
  | "indexArcBurns"
  | "indexArcMints"
  | "indexStellarBurns"
  | "indexStellarMints"
  | "syncArcBurns"
  | "syncArcMints"
  | "syncStellarBurns"
  | "syncStellarMints"
>;

export interface ApiRequestEvent {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface ApiServerOptions {
  store: TransferStore;
  cursorStore: IndexerCursorStore;
  runtime?: ApiRuntime;
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  metrics?: SettlementMetrics;
  onRequest?: (event: ApiRequestEvent) => void;
}

export interface ApiAddress {
  host: string;
  port: number;
  url: string;
}

export interface ApiServer {
  readonly server: Server;
  listen(): Promise<ApiAddress>;
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
    error instanceof TransferEvidenceError ||
    error instanceof InvalidIdempotencyKeyError ||
    error instanceof InvalidIndexerRangeError ||
    error instanceof InvalidLedgerRangeError ||
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

function requiredNetwork(body: Record<string, unknown>): Network {
  const value = requiredString(body, "network");
  if (value !== "mainnet" && value !== "testnet") {
    throw new HttpRequestError(
      400,
      "network must be mainnet or testnet",
    );
  }
  return value;
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: "Method not allowed" });
}

function routeFor(path: string): string {
  if (path === "/health" || path === "/transfers") {
    return path;
  }
  if (/^\/transfers\/[^/]+$/.test(path)) {
    return "/transfers/:idempotencyKey";
  }
  if (/^\/transfers\/[^/]+\/reconcile$/.test(path)) {
    return "/transfers/:idempotencyKey/reconcile";
  }
  if (/^\/index\/(arc|stellar)\/(burns|mints)$/.test(path)) {
    return "/index/:chain/:kind";
  }
  if (/^\/sync\/(arc|stellar)\/(burns|mints)$/.test(path)) {
    return "/sync/:chain/:kind";
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

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
  runtime: ApiRuntime,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

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
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return;
    }
    sendJson(response, 200, { transfers: await options.store.list() });
    return;
  }

  const transferMatch = /^\/transfers\/([^/]+)$/.exec(path);
  if (transferMatch) {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return;
    }
    const idempotencyKey = decodeURIComponent(transferMatch[1] as string);
    const record = await options.store.get(idempotencyKey);
    if (!record) {
      throw new TransferNotFoundError(idempotencyKey);
    }
    sendJson(response, 200, { transfer: record });
    return;
  }

  const reconcileMatch = /^\/transfers\/([^/]+)\/reconcile$/.exec(path);
  if (reconcileMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }
    const idempotencyKey = decodeURIComponent(reconcileMatch[1] as string);
    const body = requireObject(
      await readJson(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ),
    );
    const outcome = await runtime.reconcile({
      idempotencyKey,
      evidence: {
        burnTxHash: optionalString(body, "burnTxHash"),
        attestationHash: optionalString(body, "attestationHash"),
        mintTxHash: optionalString(body, "mintTxHash"),
      },
    });
    sendJson(response, 200, outcome);
    return;
  }

  const indexMatch = /^\/index\/(arc|stellar)\/(burns|mints)$/.exec(path);
  if (indexMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }
    const chain = indexMatch[1] as "arc" | "stellar";
    const kind = indexMatch[2] as "burns" | "mints";
    const body = requireObject(
      await readJson(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ),
    );

    if (chain === "arc") {
      const indexOptions = {
        network: requiredNetwork(body),
        fromBlock: requiredBigInt(body, "fromBlock"),
        toBlock: requiredBigInt(body, "toBlock"),
        rpcUrl: optionalString(body, "rpcUrl"),
      };
      const summary =
        kind === "burns"
          ? await runtime.indexArcBurns(indexOptions)
          : await runtime.indexArcMints(indexOptions);
      sendJson(response, 200, { summary });
      return;
    }

    const indexOptions = {
      network: requiredNetwork(body),
      startLedger: requiredNumber(body, "startLedger"),
      endLedger: requiredNumber(body, "endLedger"),
      rpcUrl: optionalString(body, "rpcUrl"),
    };
    const summary =
      kind === "burns"
        ? await runtime.indexStellarBurns(indexOptions)
        : await runtime.indexStellarMints(indexOptions);
    sendJson(response, 200, { summary });
    return;
  }

  const syncMatch = /^\/sync\/(arc|stellar)\/(burns|mints)$/.exec(path);
  if (syncMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }
    const chain = syncMatch[1] as "arc" | "stellar";
    const kind = syncMatch[2] as "burns" | "mints";
    const body = requireObject(
      await readJson(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ),
    );

    if (chain === "arc") {
      const syncOptions = {
        network: requiredNetwork(body),
        startBlock: requiredBigInt(body, "startBlock"),
        confirmations: requiredNumber(body, "confirmations"),
        reorgWindow: optionalBigInt(body, "reorgWindow"),
        rpcUrl: optionalString(body, "rpcUrl"),
        stream: optionalString(body, "stream"),
        cursorStore: options.cursorStore,
      };
      const result =
        kind === "burns"
          ? await runtime.syncArcBurns(syncOptions)
          : await runtime.syncArcMints(syncOptions);
      sendJson(response, 200, { result });
      return;
    }

    const syncOptions = {
      network: requiredNetwork(body),
      startLedger: requiredNumber(body, "startLedger"),
      rpcUrl: optionalString(body, "rpcUrl"),
      stream: optionalString(body, "stream"),
      cursorStore: options.cursorStore,
    };
    const result =
      kind === "burns"
        ? await runtime.syncStellarBurns(syncOptions)
        : await runtime.syncStellarMints(syncOptions);
    sendJson(response, 200, { result });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export {
  createStoreServer,
  type StoreAddress,
  type StoreRequestEvent,
  type StoreServer,
  type StoreServerOptions,
} from "./store-server.js";

export function createApiServer(options: ApiServerOptions): ApiServer {
  const runtime = options.runtime ?? createSettlementRuntime(options.store);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer((request, response) => {
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const route = routeFor(requestPath(request));

    const observe = () => {
      const status = response.statusCode;
      const durationMs = Date.now() - startedAt;
      options.metrics?.counter("parabola_api_requests_total", 1, {
        method,
        route,
        status: String(status),
      });
      options.metrics?.histogram(
        "parabola_api_request_duration_ms",
        durationMs,
        {
          method,
          route,
          status: String(status),
        },
      );
      options.onRequest?.({ method, route, status, durationMs });
    };

    void handle(request, response, options, runtime).then(
      observe,
      (error) => {
        if (response.headersSent) {
          response.destroy();
          observe();
          return;
        }
        sendJson(response, statusFor(error), { error: messageFor(error) });
        observe();
      },
    );
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
            reject(new Error("API server did not expose a TCP address"));
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
