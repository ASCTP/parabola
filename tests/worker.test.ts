import { describe, expect, it, vi } from "vitest";
import type { ArcSyncResult } from "../src/indexer/arc-sync.js";
import { MemoryIndexerCursorStore } from "../src/indexer/cursor.js";
import type { StellarSyncResult } from "../src/indexer/stellar-sync.js";
import { MemoryMetrics } from "../src/observability.js";
import {
  createIndexerWorker,
  type IndexerWorker,
  type IndexerWorkerOptions,
} from "../src/worker.js";

type WorkerRuntime = IndexerWorkerOptions["runtime"];

const EMPTY_SUMMARY = {
  reconciled: [],
  unmatched: [],
  ambiguous: [],
  skipped: [],
  busy: [],
};

function arcResult(fromBlock = 1n, toBlock = 2n): ArcSyncResult {
  return {
    summary: EMPTY_SUMMARY,
    fromBlock,
    toBlock,
    rewound: false,
  };
}

function stellarResult(fromLedger = 1, toLedger = 2): StellarSyncResult {
  return {
    summary: EMPTY_SUMMARY,
    fromLedger,
    toLedger,
  };
}

function runtime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    syncArcBurns: vi.fn().mockResolvedValue(arcResult()),
    syncArcMints: vi.fn().mockResolvedValue(arcResult()),
    syncStellarBurns: vi.fn().mockResolvedValue(stellarResult()),
    syncStellarMints: vi.fn().mockResolvedValue(stellarResult()),
    ...overrides,
  } as WorkerRuntime;
}

function options(
  overrides: Partial<IndexerWorkerOptions> = {},
): IndexerWorkerOptions {
  return {
    runtime: runtime(),
    cursorStore: new MemoryIndexerCursorStore(),
    arc: {
      network: "mainnet",
      startBlock: 1n,
      confirmations: 0,
    },
    stellar: {
      network: "mainnet",
      startLedger: 1,
    },
    ...overrides,
  };
}

describe("indexer worker", () => {
  it("runs every configured stream once", async () => {
    const source = runtime();
    const worker = createIndexerWorker(options({ runtime: source }));

    const cycle = await worker.runOnce();

    expect(cycle.tasks.map((task) => task.task)).toEqual([
      "arc-burns",
      "arc-mints",
      "stellar-burns",
      "stellar-mints",
    ]);
    expect(cycle.tasks.every((task) => task.ok)).toBe(true);
    expect(source.syncArcBurns).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "mainnet",
        startBlock: 1n,
        confirmations: 0,
      }),
    );
    expect(source.syncStellarMints).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "mainnet",
        startLedger: 1,
      }),
    );
  });

  it("records task and cycle metrics", async () => {
    const metrics = new MemoryMetrics();
    const worker = createIndexerWorker(options({ metrics }));

    await worker.runOnce();

    const samples = metrics.snapshot();
    expect(
      samples.filter(
        (sample) =>
          sample.name === "parabola_indexer_task_total" &&
          sample.labels?.status === "ok",
      ),
    ).toHaveLength(4);
    expect(
      samples.filter(
        (sample) => sample.name === "parabola_indexer_task_duration_ms",
      ),
    ).toHaveLength(4);
    expect(samples).toContainEqual(
      expect.objectContaining({
        name: "parabola_indexer_cycle_total",
        kind: "counter",
        value: 1,
        labels: { status: "ok" },
      }),
    );
  });

  it("honors per-stream burn and mint switches", async () => {
    const source = runtime();
    const worker = createIndexerWorker(
      options({
        runtime: source,
        arc: {
          network: "mainnet",
          startBlock: 1n,
          confirmations: 0,
          mints: false,
        },
        stellar: {
          network: "mainnet",
          startLedger: 1,
          burns: false,
        },
      }),
    );

    const cycle = await worker.runOnce();

    expect(cycle.tasks.map((task) => task.task)).toEqual([
      "arc-burns",
      "stellar-mints",
    ]);
    expect(source.syncArcMints).not.toHaveBeenCalled();
    expect(source.syncStellarBurns).not.toHaveBeenCalled();
  });

  it("reports one failed stream without stopping the others", async () => {
    const failure = new Error("rpc unavailable");
    const source = runtime({
      syncArcMints: vi.fn().mockRejectedValue(failure),
    });
    const onError = vi.fn();
    const worker = createIndexerWorker(options({ runtime: source, onError }));

    const cycle = await worker.runOnce();

    expect(cycle.tasks.find((task) => task.task === "arc-mints")).toMatchObject(
      {
        ok: false,
        error: failure,
      },
    );
    expect(cycle.tasks.find((task) => task.task === "arc-burns")?.ok).toBe(
      true,
    );
    expect(onError).toHaveBeenCalledWith(failure, "arc-mints");
  });

  it("requires at least one configured stream", () => {
    expect(() =>
      createIndexerWorker(options({ arc: undefined, stellar: undefined })),
    ).toThrow(/At least one indexer stream/);
  });

  it("rejects a non-positive interval", () => {
    expect(() => createIndexerWorker(options({ intervalMs: 0 }))).toThrow(
      RangeError,
    );
  });

  it("loops until stopped", async () => {
    let cycles = 0;
    let worker: IndexerWorker;
    worker = createIndexerWorker(
      options({
        intervalMs: 1,
        onCycle: () => {
          cycles += 1;
          if (cycles === 2) {
            worker.stop();
          }
        },
      }),
    );

    await worker.start();

    expect(cycles).toBe(2);
  });

  it("does not start when the caller's signal is already aborted", async () => {
    const source = runtime();
    const controller = new AbortController();
    controller.abort();
    const worker = createIndexerWorker(
      options({ runtime: source, signal: controller.signal }),
    );

    await worker.start();

    expect(source.syncArcBurns).not.toHaveBeenCalled();
  });
});
