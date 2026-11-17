import type { ArcSyncResult } from "./indexer/arc-sync.js";
import type { IndexerCursorStore } from "./indexer/cursor.js";
import type { StellarSyncResult } from "./indexer/stellar-sync.js";
import type { SettlementMetrics } from "./observability.js";
import type { SettlementRuntime } from "./runtime.js";
import type { Network } from "./types.js";

export type IndexerTaskName =
  | "arc-burns"
  | "arc-mints"
  | "stellar-burns"
  | "stellar-mints";

export interface ArcWorkerStreamOptions {
  network: Network;
  startBlock: bigint;
  confirmations: number;
  reorgWindow?: bigint;
  rpcUrl?: string;
  burns?: boolean;
  mints?: boolean;
}

export interface StellarWorkerStreamOptions {
  network: Network;
  startLedger: number;
  rpcUrl?: string;
  burns?: boolean;
  mints?: boolean;
}

export interface IndexerWorkerOptions {
  runtime: Pick<
    SettlementRuntime,
    | "syncArcBurns"
    | "syncArcMints"
    | "syncStellarBurns"
    | "syncStellarMints"
  >;
  cursorStore: IndexerCursorStore;
  arc?: ArcWorkerStreamOptions;
  stellar?: StellarWorkerStreamOptions;
  intervalMs?: number;
  signal?: AbortSignal;
  metrics?: SettlementMetrics;
  onCycle?: (cycle: WorkerCycleResult) => void;
  onError?: (error: unknown, task: IndexerTaskName) => void;
}

export interface WorkerTaskResult {
  task: IndexerTaskName;
  ok: boolean;
  result?: ArcSyncResult | StellarSyncResult;
  error?: unknown;
}

export interface WorkerCycleResult {
  startedAt: number;
  finishedAt: number;
  tasks: WorkerTaskResult[];
}

export interface IndexerWorker {
  runOnce(): Promise<WorkerCycleResult>;
  start(): Promise<void>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 15_000;

interface Task {
  name: IndexerTaskName;
  run: () => Promise<ArcSyncResult | StellarSyncResult>;
}

function configuredTasks(options: IndexerWorkerOptions): Task[] {
  const tasks: Task[] = [];

  if (options.arc) {
    if (options.arc.burns !== false) {
      const stream = options.arc;
      tasks.push({
        name: "arc-burns",
        run: () =>
          options.runtime.syncArcBurns({
            network: stream.network,
            startBlock: stream.startBlock,
            confirmations: stream.confirmations,
            reorgWindow: stream.reorgWindow,
            rpcUrl: stream.rpcUrl,
            cursorStore: options.cursorStore,
          }),
      });
    }
    if (options.arc.mints !== false) {
      const stream = options.arc;
      tasks.push({
        name: "arc-mints",
        run: () =>
          options.runtime.syncArcMints({
            network: stream.network,
            startBlock: stream.startBlock,
            confirmations: stream.confirmations,
            reorgWindow: stream.reorgWindow,
            rpcUrl: stream.rpcUrl,
            cursorStore: options.cursorStore,
          }),
      });
    }
  }

  if (options.stellar) {
    if (options.stellar.burns !== false) {
      const stream = options.stellar;
      tasks.push({
        name: "stellar-burns",
        run: () =>
          options.runtime.syncStellarBurns({
            network: stream.network,
            startLedger: stream.startLedger,
            rpcUrl: stream.rpcUrl,
            cursorStore: options.cursorStore,
          }),
      });
    }
    if (options.stellar.mints !== false) {
      const stream = options.stellar;
      tasks.push({
        name: "stellar-mints",
        run: () =>
          options.runtime.syncStellarMints({
            network: stream.network,
            startLedger: stream.startLedger,
            rpcUrl: stream.rpcUrl,
            cursorStore: options.cursorStore,
          }),
      });
    }
  }

  return tasks;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Indexer worker stopped"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Indexer worker stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason;
}

export function createIndexerWorker(
  options: IndexerWorkerOptions,
): IndexerWorker {
  const tasks = configuredTasks(options);
  if (tasks.length === 0) {
    throw new Error("At least one indexer stream must be configured");
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive integer");
  }

  const controller = new AbortController();
  let running = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error("Indexer worker stopped"));
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      stop();
    } else {
      options.signal.addEventListener("abort", stop, { once: true });
    }
  }

  async function runOnce(): Promise<WorkerCycleResult> {
    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      tasks.map(async (task) => {
        const taskStartedAt = Date.now();
        try {
          const result = await task.run();
          options.metrics?.counter("parabola_indexer_task_total", 1, {
            task: task.name,
            status: "ok",
          });
          options.metrics?.histogram(
            "parabola_indexer_task_duration_ms",
            Date.now() - taskStartedAt,
            { task: task.name },
          );
          return result;
        } catch (error) {
          options.metrics?.counter("parabola_indexer_task_total", 1, {
            task: task.name,
            status: "error",
          });
          options.metrics?.histogram(
            "parabola_indexer_task_duration_ms",
            Date.now() - taskStartedAt,
            { task: task.name },
          );
          throw error;
        }
      }),
    );

    const results: WorkerTaskResult[] = settled.map((outcome, index) => {
      const task = tasks[index] as Task;
      if (outcome.status === "fulfilled") {
        return { task: task.name, ok: true, result: outcome.value };
      }
      options.onError?.(outcome.reason, task.name);
      return { task: task.name, ok: false, error: outcome.reason };
    });

    const finishedAt = Date.now();
    const failed = results.filter((result) => !result.ok).length;
    options.metrics?.counter("parabola_indexer_cycle_total", 1, {
      status: failed === 0 ? "ok" : "partial",
    });
    options.metrics?.histogram(
      "parabola_indexer_cycle_duration_ms",
      finishedAt - startedAt,
    );

    const cycle: WorkerCycleResult = {
      startedAt,
      finishedAt,
      tasks: results,
    };
    options.onCycle?.(cycle);
    return cycle;
  }

  async function start(): Promise<void> {
    if (running) {
      throw new Error("Indexer worker is already running");
    }
    if (stopped) {
      return;
    }
    running = true;

    try {
      while (!stopped) {
        await runOnce();
        if (stopped) {
          break;
        }
        try {
          await sleep(intervalMs, controller.signal);
        } catch (err) {
          if (isAbort(err, controller.signal)) {
            break;
          }
          throw err;
        }
      }
    } finally {
      running = false;
    }
  }

  return { runOnce, start, stop };
}
