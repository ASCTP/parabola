import { describe, expect, it } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { transferWebhookEvent } from "../../src/webhooks/transfer-event.js";

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "minted",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe("transfer webhook events", () => {
  it("maps terminal phases to event types", () => {
    expect(transferWebhookEvent(record({ phase: "minted" })).type).toBe(
      "transfer.minted",
    );
    expect(transferWebhookEvent(record({ phase: "pending" })).type).toBe(
      "transfer.pending",
    );
    expect(transferWebhookEvent(record({ phase: "recoverable" })).type).toBe(
      "transfer.recoverable",
    );
    expect(transferWebhookEvent(record({ phase: "failed" })).type).toBe(
      "transfer.failed",
    );
    expect(transferWebhookEvent(record({ phase: "burning" })).type).toBe(
      "transfer.updated",
    );
  });

  it("uses the record as the event data without sharing the result", () => {
    const source = record({
      result: {
        status: "success",
        transferMode: "fast",
        burnTxHash: "0xburn",
        attestationHash: "0xattestation",
        mintTxHash: "0xmint",
        fee: "0.01",
        durationMs: 1_000,
      },
    });

    const event = transferWebhookEvent(source, {
      id: "evt_1",
      createdAt: 3_000,
    });
    (event.data.result as { mintTxHash: string }).mintTxHash = "0xother";

    expect(event).toMatchObject({
      id: "evt_1",
      type: "transfer.minted",
      createdAt: 3_000,
      data: { idempotencyKey: "order-1" },
    });
    expect(source.result?.mintTxHash).toBe("0xmint");
  });

  it("allows an explicit event type", () => {
    const event = transferWebhookEvent(record(), {
      type: "transfer.failed",
    });

    expect(event.type).toBe("transfer.failed");
  });

  it("rejects an empty id and a non-finite timestamp", () => {
    expect(() => transferWebhookEvent(record(), { id: "" })).toThrow(
      RangeError,
    );
    expect(() =>
      transferWebhookEvent(record(), {
        createdAt: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(RangeError);
  });
});
