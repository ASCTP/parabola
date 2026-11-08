import { describe, expect, it } from "vitest";
import { TransferError } from "../../src/errors.js";
import type { SettlementKernel } from "../../src/kernel/contracts.js";
import type { TransferPhase } from "../../src/kernel/state.js";
import type { TransferRecord, TransferStore } from "../../src/execution/contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferPersistenceError,
} from "../../src/execution/errors.js";
import { executeTransfer } from "../../src/execution/executor.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import type { TransferParams, TransferResult } from "../../src/types.js";

const RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

const PARAMS = {
  from: "arc",
  to: "stellar",
  amount: "10",
  recipient: RECIPIENT,
  speed: "standard",
  signer: { walletClient: {} },
} as unknown as TransferParams;

function result(overrides: Partial<TransferResult> = {}): TransferResult {
  return {
    status: "success",
    transferMode: "standard",
    burnTxHash: "burn-1",
    attestationHash: "0xattestation",
    mintTxHash: "mint-1",
    fee: "0.01",
    durationMs: 1200,
    ...overrides,
  };
}

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "planned",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function kernel(transfer: SettlementKernel["transfer"]): SettlementKernel {
  return {
    transfer,
    async completeMint() {
      throw new Error("completeMint is not part of this test");
    },
    async resolveBurn() {
      throw new Error("resolveBurn is not part of this test");
    },
  };
}

function failingPut(phase: TransferPhase): TransferStore {
  const inner = new MemoryTransferStore();
  return {
    get: (key) => inner.get(key),
    create: (value) => inner.create(value),
    delete: (key) => inner.delete(key),
    async put(value) {
      if (value.phase === phase) {
        throw new Error("disk full");
      }
      await inner.put(value);
    },
  };
}

describe("durable transfer executor", () => {
  it("rejects a blank idempotency key before touching the store", async () => {
    const store = new MemoryTransferStore();
    let calls = 0;

    const err = await executeTransfer(
      kernel(async () => {
        calls += 1;
        return result();
      }),
      store,
      PARAMS,
      { idempotencyKey: "   " },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(InvalidIdempotencyKeyError);
    expect(calls).toBe(0);
  });

  it("persists a successful transfer and returns the completed record", async () => {
    const store = new MemoryTransferStore();
    const expected = result();

    const outcome = await executeTransfer(
      kernel(async () => expected),
      store,
      PARAMS,
      { idempotencyKey: "  order-1  " },
    );

    expect(outcome.result).toBe(expected);
    expect(outcome.record).toMatchObject({
      idempotencyKey: "order-1",
      phase: "minted",
      from: "arc",
      to: "stellar",
      network: "mainnet",
      amount: "10",
      recipient: RECIPIENT,
      burnTxHash: "burn-1",
      attestationHash: "0xattestation",
      mintTxHash: "mint-1",
      result: expected,
    });
    expect(await store.get("order-1")).toEqual(outcome.record);
  });

  it("defaults the network to mainnet", async () => {
    const store = new MemoryTransferStore();

    const outcome = await executeTransfer(
      kernel(async () => result()),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    );

    expect(outcome.record.network).toBe("mainnet");
  });

  it("replays a pending result without repeating the burn", async () => {
    const store = new MemoryTransferStore();
    let calls = 0;
    const expected = result({
      status: "pending",
      mintTxHash: "",
      durationMs: 800,
    });
    const client = kernel(async () => {
      calls += 1;
      return expected;
    });

    const first = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });
    const second = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });

    expect(calls).toBe(1);
    expect(first.record.phase).toBe("pending");
    expect(first.record.mintTxHash).toBeUndefined();
    expect(second).toEqual(first);
  });

  it("replays a minted result without repeating the transfer", async () => {
    const store = new MemoryTransferStore();
    let calls = 0;
    const client = kernel(async () => {
      calls += 1;
      return result();
    });

    const first = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });
    const second = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });

    expect(calls).toBe(1);
    expect(first.record.phase).toBe("minted");
    expect(second).toEqual(first);
  });

  it.each([
    ["in_progress", "burning"],
    ["recoverable", "recoverable"],
    ["failed", "failed"],
  ] as const)(
    "rejects a %s transfer without calling the kernel",
    async (reason, phase) => {
      const store = new MemoryTransferStore();
      await store.create(record({ phase }));
      let calls = 0;

      const err = await executeTransfer(
        kernel(async () => {
          calls += 1;
          return result();
        }),
        store,
        PARAMS,
        { idempotencyKey: "order-1" },
      ).catch((error) => error);

      expect(err).toBeInstanceOf(TransferConflictError);
      expect(err).toMatchObject({
        reason,
        record: { idempotencyKey: "order-1", phase },
      });
      expect(calls).toBe(0);
    },
  );

  it("marks a post-burn failure recoverable and preserves its recovery hashes", async () => {
    const store = new MemoryTransferStore();
    const failure = new TransferError(
      "attestation is not ready",
      "burn-9",
      "0xattestation",
      "ATTESTATION_NOT_READY",
    );

    const err = await executeTransfer(
      kernel(async () => {
        throw failure;
      }),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBe(failure);
    expect(await store.get("order-1")).toMatchObject({
      phase: "recoverable",
      burnTxHash: "burn-9",
      attestationHash: "0xattestation",
      error: "attestation is not ready",
    });
  });

  it("marks a pre-burn failure failed and rethrows the original error", async () => {
    const store = new MemoryTransferStore();
    const failure = new Error("burn rejected");

    const err = await executeTransfer(
      kernel(async () => {
        throw failure;
      }),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBe(failure);
    expect(await store.get("order-1")).toMatchObject({
      phase: "failed",
      error: "burn rejected",
    });
  });

  it("allows only one concurrent call to run the kernel", async () => {
    const store = new MemoryTransferStore();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = kernel(async () => {
      calls += 1;
      await gate;
      return result();
    });

    const first = executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });
    const second = executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });
    const settled = Promise.allSettled([first, second]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const outcomes = await settled;

    expect(calls).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { reason: "in_progress" },
    });
  });

  it("wraps a completed-state persistence failure with the result", async () => {
    const expected = result();

    const err = await executeTransfer(
      kernel(async () => expected),
      failingPut("minted"),
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(TransferPersistenceError);
    expect(err).toMatchObject({
      record: { phase: "minted" },
      result: expected,
    });
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it("wraps a failure-state persistence failure", async () => {
    const err = await executeTransfer(
      kernel(async () => {
        throw new Error("rpc unavailable");
      }),
      failingPut("failed"),
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(TransferPersistenceError);
    expect(err).toMatchObject({ record: { phase: "failed" } });
    expect((err as Error).cause).toBeInstanceOf(Error);
  });
});
