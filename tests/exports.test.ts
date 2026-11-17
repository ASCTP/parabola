import { describe, expect, it } from "vitest";
import * as execution from "../src/execution/index.js";
import * as indexer from "../src/indexer/index.js";
import * as observability from "../src/observability.js";

describe("package subpath exports", () => {
  it("exposes the durable execution surface", () => {
    expect(execution.executeTransfer).toBeTypeOf("function");
    expect(execution.reconcileTransfer).toBeTypeOf("function");
    expect(execution.MemoryTransferStore).toBeTypeOf("function");
    expect(execution.FileTransferStore).toBeTypeOf("function");
  });

  it("exposes the indexer surface", () => {
    expect(indexer.indexArcBurns).toBeTypeOf("function");
    expect(indexer.indexStellarMints).toBeTypeOf("function");
    expect(indexer.syncArcBurns).toBeTypeOf("function");
    expect(indexer.syncStellarBurns).toBeTypeOf("function");
    expect(indexer.MemoryIndexerCursorStore).toBeTypeOf("function");
    expect(indexer.FileIndexerCursorStore).toBeTypeOf("function");
  });

  it("exposes the observability surface", () => {
    expect(observability.MemoryMetrics).toBeTypeOf("function");
    expect(observability.MemoryLogger).toBeTypeOf("function");
    expect(observability.JsonLogger).toBeTypeOf("function");
    expect(observability.noopMetrics).toBeDefined();
  });
});
