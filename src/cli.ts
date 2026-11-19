import { createApiServer } from "./api.js";
import { createStoreServer } from "./store-server.js";
import { FileTransferStore } from "./execution/file-store.js";
import { FileIndexerCursorStore } from "./indexer/cursor.js";
import { createSettlementRuntime } from "./runtime.js";
import type { ChainId, Network } from "./types.js";
import {
  createIndexerWorker,
  type ArcWorkerStreamOptions,
  type StellarWorkerStreamOptions,
  type WorkerCycleResult,
} from "./worker.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

const DEFAULT_STORE_DIR = ".parabola/transfers";
const DEFAULT_CURSOR_DIR = ".parabola/cursors";
const DEFAULT_ARC_CONFIRMATIONS = 12;
const DEFAULT_INTERVAL_MS = 15_000;

const USAGE = `Usage: parabola <command> [options]

Commands:
  list       List stored transfer records
  reconcile  Apply burn, attestation, or mint evidence to a record
  resolve    Read what a burn has already committed to
  sync       Advance indexer cursors once or continuously
  serve      Start the HTTP operations API
  store      Start the HTTP store and lease server

Common options:
  --store-dir <path>      Transfer store directory (default: ${DEFAULT_STORE_DIR})
  --network <name>        mainnet or testnet (default: mainnet)
  --json                  Print machine-readable JSON

reconcile:
  --key <idempotencyKey>  Required
  --burn-tx <hash>
  --attestation <hash>
  --mint-tx <hash>

resolve:
  --from <arc|stellar>    Required
  --burn-tx <hash>        Required

sync:
  --cursor-dir <path>     Cursor store directory (default: ${DEFAULT_CURSOR_DIR})
  --arc-start-block <n>
  --arc-confirmations <n> Default: ${DEFAULT_ARC_CONFIRMATIONS}
  --arc-reorg-window <n>
  --stellar-start-ledger <n>
  --no-arc-burns          Disable Arc burn indexing
  --no-arc-mints          Disable Arc mint indexing
  --no-stellar-burns      Disable Stellar burn indexing
  --no-stellar-mints      Disable Stellar mint indexing
  --watch                 Keep running
  --interval <ms>         Watch interval (default: ${DEFAULT_INTERVAL_MS})

serve:
  --cursor-dir <path>     Cursor store directory (default: ${DEFAULT_CURSOR_DIR})
  --host <name>           Bind address (default: 127.0.0.1)
  --port <n>              Bind port (default: 8787)
  --token <value>         Bearer token, or set PARABOLA_API_TOKEN

store:
  --store-dir <path>      Transfer store directory (default: ${DEFAULT_STORE_DIR})
  --cursor-dir <path>     Cursor store directory (default: ${DEFAULT_CURSOR_DIR})
  --host <name>           Bind address (default: 127.0.0.1)
  --port <n>              Bind port (default: 8788)
  --token <value>         Bearer token, or set PARABOLA_STORE_TOKEN
`;

interface ParsedArgs {
  values: Map<string, string | true | false>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string | true | false>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    if (raw === "") {
      throw new Error("Invalid empty option");
    }
    const equals = raw.indexOf("=");
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);

    if (name.startsWith("no-")) {
      values.set(name.slice(3), false);
      continue;
    }
    if (inline !== undefined) {
      values.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
      continue;
    }
    values.set(name, true);
  }

  return { values, positionals };
}

function assertKnownFlags(
  parsed: ParsedArgs,
  allowed: string[],
): void {
  const known = new Set(allowed);
  for (const name of parsed.values.keys()) {
    if (!known.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
  }
}

function stringFlag(
  parsed: ParsedArgs,
  name: string,
  fallback?: string,
): string | undefined {
  const value = parsed.values.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Option --${name} requires a value`);
  }
  return value;
}

function requiredStringFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function booleanFlag(
  parsed: ParsedArgs,
  name: string,
  fallback = false,
): boolean {
  const value = parsed.values.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  throw new Error(`Option --${name} must be true or false`);
}

function networkFlag(parsed: ParsedArgs): Network {
  const value = stringFlag(parsed, "network", "mainnet");
  if (value !== "mainnet" && value !== "testnet") {
    throw new Error("--network must be mainnet or testnet");
  }
  return value;
}

function integerFlag(
  parsed: ParsedArgs,
  name: string,
  fallback?: number,
): number | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    return fallback;
  }
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsedValue;
}

function bigintFlag(
  parsed: ParsedArgs,
  name: string,
): bigint | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsedValue = BigInt(value);
    if (parsedValue < 0n) {
      throw new Error("negative");
    }
    return parsedValue;
  } catch {
    throw new Error(`--${name} must be a non-negative integer`);
  }
}

function chainFlag(parsed: ParsedArgs): ChainId {
  const value = requiredStringFlag(parsed, "from");
  if (value !== "arc" && value !== "stellar") {
    throw new Error("--from must be arc or stellar");
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    2,
  );
}

function write(io: CliIo, line: string): void {
  io.stdout.write(`${line}\n`);
}

function writeError(io: CliIo, line: string): void {
  io.stderr.write(`${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeCycle(cycle: WorkerCycleResult): string {
  return cycle.tasks
    .map((task) => {
      if (task.ok) {
        return `${task.task}: ok`;
      }
      return `${task.task}: failed (${errorMessage(task.error)})`;
    })
    .join("\n");
}

async function listCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, ["store-dir", "json"]);
  const store = new FileTransferStore(
    stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
  );
  const records = await store.list();

  if (booleanFlag(parsed, "json")) {
    write(io, json(records));
    return 0;
  }
  if (records.length === 0) {
    write(io, "No transfers.");
    return 0;
  }
  write(io, "KEY\tPHASE\tROUTE\tAMOUNT\tNETWORK\tUPDATED");
  for (const record of records) {
    write(
      io,
      [
        record.idempotencyKey,
        record.phase,
        `${record.from}->${record.to}`,
        record.amount,
        record.network,
        new Date(record.updatedAt).toISOString(),
      ].join("\t"),
    );
  }
  return 0;
}

async function reconcileCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, [
    "store-dir",
    "key",
    "burn-tx",
    "attestation",
    "mint-tx",
    "json",
  ]);
  const idempotencyKey = requiredStringFlag(parsed, "key");
  const evidence = {
    burnTxHash: stringFlag(parsed, "burn-tx"),
    attestationHash: stringFlag(parsed, "attestation"),
    mintTxHash: stringFlag(parsed, "mint-tx"),
  };
  if (
    evidence.burnTxHash === undefined &&
    evidence.attestationHash === undefined &&
    evidence.mintTxHash === undefined
  ) {
    throw new Error(
      "At least one of --burn-tx, --attestation, or --mint-tx is required",
    );
  }

  const store = new FileTransferStore(
    stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
  );
  const runtime = createSettlementRuntime(store);
  const outcome = await runtime.reconcile({ idempotencyKey, evidence });

  if (booleanFlag(parsed, "json")) {
    write(io, json(outcome));
    return 0;
  }
  write(
    io,
    `${outcome.record.idempotencyKey}: ${outcome.record.phase} (${outcome.changed ? "changed" : "unchanged"})`,
  );
  if (outcome.result) {
    write(io, `status: ${outcome.result.status}`);
    if (outcome.result.mintTxHash) {
      write(io, `mint: ${outcome.result.mintTxHash}`);
    }
  }
  return 0;
}

async function resolveCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, ["store-dir", "from", "burn-tx", "network", "json"]);
  const from = chainFlag(parsed);
  const burnTxHash = requiredStringFlag(parsed, "burn-tx");
  const network = networkFlag(parsed);
  const store = new FileTransferStore(
    stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
  );
  const runtime = createSettlementRuntime(store);
  const resolved = await runtime.resolveBurn({ from, burnTxHash, network });

  if (booleanFlag(parsed, "json")) {
    write(io, json(resolved));
    return 0;
  }
  write(io, `source domain: ${resolved.sourceDomain}`);
  write(io, `destination domain: ${resolved.destinationDomain}`);
  write(io, `amount raw: ${resolved.amountRaw}`);
  if (resolved.forwardRecipient) {
    write(io, `forward recipient: ${resolved.forwardRecipient}`);
  }
  write(
    io,
    `attestation: ${resolved.attestation ? "ready" : "pending"}`,
  );
  return 0;
}

function arcOptions(
  parsed: ParsedArgs,
  network: Network,
): ArcWorkerStreamOptions | undefined {
  const startBlock = bigintFlag(parsed, "arc-start-block");
  if (startBlock === undefined) {
    return undefined;
  }
  return {
    network,
    startBlock,
    confirmations:
      integerFlag(
        parsed,
        "arc-confirmations",
        DEFAULT_ARC_CONFIRMATIONS,
      ) as number,
    reorgWindow: bigintFlag(parsed, "arc-reorg-window"),
    burns: booleanFlag(parsed, "arc-burns", true),
    mints: booleanFlag(parsed, "arc-mints", true),
  };
}

function stellarOptions(
  parsed: ParsedArgs,
  network: Network,
): StellarWorkerStreamOptions | undefined {
  const startLedger = integerFlag(parsed, "stellar-start-ledger");
  if (startLedger === undefined) {
    return undefined;
  }
  return {
    network,
    startLedger,
    burns: booleanFlag(parsed, "stellar-burns", true),
    mints: booleanFlag(parsed, "stellar-mints", true),
  };
}

async function syncCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, [
    "store-dir",
    "cursor-dir",
    "network",
    "arc-start-block",
    "arc-confirmations",
    "arc-reorg-window",
    "arc-burns",
    "arc-mints",
    "stellar-start-ledger",
    "stellar-burns",
    "stellar-mints",
    "watch",
    "interval",
    "json",
  ]);

  const network = networkFlag(parsed);
  const arc = arcOptions(parsed, network);
  const stellar = stellarOptions(parsed, network);
  if (arc === undefined && stellar === undefined) {
    throw new Error(
      "At least one of --arc-start-block or --stellar-start-ledger is required",
    );
  }

  const store = new FileTransferStore(
    stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
  );
  const cursorStore = new FileIndexerCursorStore(
    stringFlag(parsed, "cursor-dir", DEFAULT_CURSOR_DIR) as string,
  );
  const runtime = createSettlementRuntime(store);
  const watch = booleanFlag(parsed, "watch");
  const asJson = booleanFlag(parsed, "json");

  const worker = createIndexerWorker({
    runtime,
    cursorStore,
    arc,
    stellar,
    intervalMs: integerFlag(parsed, "interval", DEFAULT_INTERVAL_MS),
    onCycle: (cycle) => {
      write(io, asJson ? json(cycle) : summarizeCycle(cycle));
    },
  });

  if (!watch) {
    const cycle = await worker.runOnce();
    return cycle.tasks.every((task) => task.ok) ? 0 : 1;
  }

  write(
    io,
    `Watching ${[arc ? "arc" : undefined, stellar ? "stellar" : undefined]
      .filter(Boolean)
      .join(" and ")} on ${network}. Press Ctrl+C to stop.`,
  );

  const shutdown = () => worker.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await worker.start();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
  return 0;
}

async function serveCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, [
    "store-dir",
    "cursor-dir",
    "host",
    "port",
    "token",
  ]);

  const store = new FileTransferStore(
    stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
  );
  const cursorStore = new FileIndexerCursorStore(
    stringFlag(parsed, "cursor-dir", DEFAULT_CURSOR_DIR) as string,
  );
  const api = createApiServer({
    store,
    cursorStore,
    host: stringFlag(parsed, "host", "127.0.0.1"),
    port: integerFlag(parsed, "port", 8787) as number,
    token: stringFlag(parsed, "token", process.env.PARABOLA_API_TOKEN),
  });

  return await runUntilSignal(api, io);
}

async function storeCommand(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(parsed, [
    "store-dir",
    "cursor-dir",
    "host",
    "port",
    "token",
  ]);

  const server = createStoreServer({
    transferStore: new FileTransferStore(
      stringFlag(parsed, "store-dir", DEFAULT_STORE_DIR) as string,
    ),
    cursorStore: new FileIndexerCursorStore(
      stringFlag(parsed, "cursor-dir", DEFAULT_CURSOR_DIR) as string,
    ),
    host: stringFlag(parsed, "host", "127.0.0.1"),
    port: integerFlag(parsed, "port", 8788) as number,
    token: stringFlag(parsed, "token", process.env.PARABOLA_STORE_TOKEN),
  });
  return await runUntilSignal(server, io);
}

async function runUntilSignal(
  server: {
    listen(): Promise<{ url: string }>;
    close(): Promise<void>;
  },
  io: CliIo,
): Promise<number> {
  const address = await server.listen();
  write(io, `Listening on ${address.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return 0;
}

export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);

  try {
    if (command === undefined || command === "help" || command === "--help") {
      write(io, USAGE.trimEnd());
      return 0;
    }
    if (parsed.positionals.length > 0) {
      throw new Error(`Unexpected argument: ${parsed.positionals[0]}`);
    }

    switch (command) {
      case "list":
        return await listCommand(parsed, io);
      case "reconcile":
        return await reconcileCommand(parsed, io);
      case "resolve":
        return await resolveCommand(parsed, io);
      case "sync":
        return await syncCommand(parsed, io);
      case "serve":
        return await serveCommand(parsed, io);
      case "store":
        return await storeCommand(parsed, io);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    writeError(io, `error: ${errorMessage(error)}`);
    return 1;
  }
}
