export type MetricKind = "counter" | "gauge" | "histogram";

export type MetricLabels = Record<string, string>;

export interface MetricSample {
  name: string;
  kind: MetricKind;
  value: number;
  labels?: MetricLabels;
  timestamp: number;
}

export interface SettlementMetrics {
  counter(name: string, value?: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  histogram(name: string, value: number, labels?: MetricLabels): void;
}

function copyLabels(
  labels: MetricLabels | undefined,
): MetricLabels | undefined {
  return labels ? { ...labels } : undefined;
}

export class MemoryMetrics implements SettlementMetrics {
  private readonly recorded: MetricSample[] = [];

  counter(
    name: string,
    value = 1,
    labels?: MetricLabels,
  ): void {
    this.record(name, "counter", value, labels);
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    this.record(name, "gauge", value, labels);
  }

  histogram(
    name: string,
    value: number,
    labels?: MetricLabels,
  ): void {
    this.record(name, "histogram", value, labels);
  }

  snapshot(): MetricSample[] {
    return this.recorded.map((sample) => ({
      ...sample,
      labels: copyLabels(sample.labels),
    }));
  }

  reset(): void {
    this.recorded.length = 0;
  }

  private record(
    name: string,
    kind: MetricKind,
    value: number,
    labels: MetricLabels | undefined,
  ): void {
    this.recorded.push({
      name,
      kind,
      value,
      labels: copyLabels(labels),
      timestamp: Date.now(),
    });
  }
}

export const noopMetrics: SettlementMetrics = {
  counter() {},
  gauge() {},
  histogram() {},
};

export type SettlementLogLevel = "debug" | "info" | "warn" | "error";

export interface SettlementLogRecord {
  level: SettlementLogLevel;
  event: string;
  timestamp: number;
  fields?: Record<string, unknown>;
}

export interface SettlementLogger {
  log(record: SettlementLogRecord): void;
}

export type LogSink = (line: string) => void;

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export class JsonLogger implements SettlementLogger {
  constructor(
    private readonly sink: LogSink = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  log(record: SettlementLogRecord): void {
    this.sink(JSON.stringify(record, jsonReplacer));
  }
}

export class MemoryLogger implements SettlementLogger {
  private readonly records: SettlementLogRecord[] = [];

  log(record: SettlementLogRecord): void {
    this.records.push({
      ...record,
      fields: record.fields ? { ...record.fields } : undefined,
    });
  }

  snapshot(): SettlementLogRecord[] {
    return this.records.map((record) => ({
      ...record,
      fields: record.fields ? { ...record.fields } : undefined,
    }));
  }

  reset(): void {
    this.records.length = 0;
  }
}
