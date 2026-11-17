import { describe, expect, it } from "vitest";
import {
  JsonLogger,
  MemoryLogger,
  MemoryMetrics,
  noopMetrics,
} from "../src/observability.js";

describe("memory metrics", () => {
  it("records counters, gauges, and histograms", () => {
    const metrics = new MemoryMetrics();

    metrics.counter("requests");
    metrics.counter("requests", 2, { route: "/health" });
    metrics.gauge("inflight", 3);
    metrics.histogram("latency_ms", 12, { route: "/health" });

    expect(metrics.snapshot()).toMatchObject([
      { name: "requests", kind: "counter", value: 1 },
      {
        name: "requests",
        kind: "counter",
        value: 2,
        labels: { route: "/health" },
      },
      { name: "inflight", kind: "gauge", value: 3 },
      {
        name: "latency_ms",
        kind: "histogram",
        value: 12,
        labels: { route: "/health" },
      },
    ]);
  });

  it("copies labels so later mutations do not leak", () => {
    const metrics = new MemoryMetrics();
    const labels = { route: "/health" };

    metrics.counter("requests", 1, labels);
    labels.route = "/transfers";

    const snapshot = metrics.snapshot();
    expect(snapshot[0]?.labels).toEqual({ route: "/health" });

    (snapshot[0]?.labels as Record<string, string>).route = "/other";
    expect(metrics.snapshot()[0]?.labels).toEqual({ route: "/health" });
  });

  it("resets recorded samples", () => {
    const metrics = new MemoryMetrics();
    metrics.counter("requests");
    metrics.reset();

    expect(metrics.snapshot()).toEqual([]);
  });
});

describe("logging", () => {
  it("writes one JSON object per event", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    logger.log({
      level: "info",
      event: "transfer.started",
      timestamp: 1,
      fields: { idempotencyKey: "order-1", amount: 10n },
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: "info",
      event: "transfer.started",
      timestamp: 1,
      fields: { idempotencyKey: "order-1", amount: "10" },
    });
  });

  it("keeps structured records in memory", () => {
    const logger = new MemoryLogger();
    const fields = { task: "arc-burns" };

    logger.log({
      level: "warn",
      event: "indexer.task.failed",
      timestamp: 1,
      fields,
    });
    fields.task = "arc-mints";

    const snapshot = logger.snapshot();
    expect(snapshot[0]?.fields).toEqual({ task: "arc-burns" });

    (snapshot[0]?.fields as Record<string, unknown>).task = "other";
    expect(logger.snapshot()[0]?.fields).toEqual({ task: "arc-burns" });
  });

  it("provides a no-op metrics implementation", () => {
    expect(() => {
      noopMetrics.counter("requests");
      noopMetrics.gauge("inflight", 1);
      noopMetrics.histogram("latency_ms", 1);
    }).not.toThrow();
  });
});
