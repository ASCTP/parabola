import { describe, expect, it } from "vitest";
import * as conformance from "../src/conformance/index.js";
import * as execution from "../src/execution/index.js";
import * as indexer from "../src/indexer/index.js";
import * as observability from "../src/observability.js";
import * as providers from "../src/providers/index.js";
import * as webhooks from "../src/webhooks/index.js";

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

  it("exposes the conformance surface", () => {
    expect(conformance.ConformanceError).toBeTypeOf("function");
    expect(conformance.assertChainAdapterConforms).toBeTypeOf("function");
    expect(conformance.assertSettlementDependenciesConform).toBeTypeOf(
      "function",
    );
    expect(conformance.probeChainAdapter).toBeTypeOf("function");
  });

  it("exposes the provider surface", () => {
    expect(providers.ChainAdapterRegistry).toBeTypeOf("function");
    expect(providers.ProviderRegistryError).toBeTypeOf("function");
    expect(providers.defaultSettlementDependencies).toBeDefined();
  });

  it("exposes the webhook surface", () => {
    expect(webhooks.WebhookDispatcher).toBeTypeOf("function");
    expect(webhooks.WebhookReplayGuard).toBeTypeOf("function");
    expect(webhooks.MemoryWebhookDeliveryStore).toBeTypeOf("function");
    expect(webhooks.FileWebhookDeliveryStore).toBeTypeOf("function");
    expect(webhooks.signWebhookPayload).toBeTypeOf("function");
    expect(webhooks.verifyWebhookSignature).toBeTypeOf("function");
    expect(webhooks.transferWebhookEvent).toBeTypeOf("function");
  });
});
