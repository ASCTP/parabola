import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TransferStore } from "./execution/contracts.js";
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
import {
  createSettlementRuntime,
  type SettlementRuntime,
} from "./runtime.js";
import type { Network } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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

export interface ApiServerOptions {
  store: TransferStore;
  cursorStore: IndexerCursorStore;
  runtime?: ApiRuntime;
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
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

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

function statusFor(error: unknown): number {
  if (error instanceof ApiError) {
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

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(
    body,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new ApiError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Request body is not valid JSON");
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, `${name} must be a non-empty string`);
  }
  return value;
}

function requiredString(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = optionalString(body, name);
  if (value === undefined) {
    throw new ApiError(400, `${name} is required`);
  }
  return value;
}

function requiredBigInt(
  body: Record<string, unknown>,
  name: string,
): bigint {
  const value = body[name];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw new ApiError(400, `${name} must be a non-negative integer`);
}

function optionalBigInt(
  body: Record<string, unknown>,
  name: string,
): bigint | undefined {
  if (body[name] === undefined || body[name] === null) {
    return undefined;
  }
  return requiredBigInt(body, name);
}

function requiredNumber(
  body: Record<string, unknown>,
  name: string,
): number {
  const value = body[name];
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new ApiError(400, `${name} must be a non-negative integer`);
}

function requiredNetwork(body: Record<string, unknown>): Network {
  const value = requiredString(body, "network");
  if (value !== "mainnet" && value !== "testnet") {
    throw new ApiError(400, "network must be mainnet or testnet");
  }
  return value;
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: "Method not allowed" });
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

export function createApiServer(options: ApiServerOptions): ApiServer {
  const runtime = options.runtime ?? createSettlementRuntime(options.store);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer((request, response) => {
    void handle(request, response, options, runtime).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, statusFor(error), { error: messageFor(error) });
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
