import { describe, expect, it, vi } from "vitest";
import { AttestationNotReadyError, TransferError } from "../../src/errors.js";
import type { SettlementKernel } from "../../src/kernel/contracts.js";
import { TransferProgressError } from "../../src/kernel/errors.js";
import type { TransferPhase } from "../../src/kernel/state.js";
import type {
  TransferRecord,
  TransferStore,
} from "../../src/execution/contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferLeaseLostError,
  TransferPersistenceError,
} from "../../src/execution/errors.js";
import { executeTransfer } from "../../src/execution/executor.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import type {
  CompleteMintParams,
  TransferParams,
  TransferResult,
} from "../../src/types.js";

const RECIPIENT = "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

const DESTINATION_SIGNER = { publicKey: "GDESTINATION" };

const PARAMS = {
  from: "arc",
  to: "stellar",
  amount: "10",
  recipient: RECIPIENT,
  speed: "standard",
  signer: {
    walletClient: {
      account: { address: "0x1111111111111111111111111111111111111111" },
    },
  },
} as unknown as TransferParams;

const PARAMS_WITH_DESTINATION = {
  ...PARAMS,
  options: { destinationSigner: DESTINATION_SIGNER },
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

function kernel(
  transfer: SettlementKernel["transfer"],
  completeMint: SettlementKernel["completeMint"] = async () => {
    throw new Error("completeMint is not part of this test");
  },
): SettlementKernel {
  return {
    transfer,
    completeMint,
    async resolveBurn() {
      throw new Error("resolveBurn is not part of this test");
    },
  };
}

function failingPut(phase: TransferPhase): TransferStore {
  const inner = new MemoryTransferStore();
  return {
    get: (key) => inner.get(key),
    list: () => inner.list(),
    create: (value) => inner.create(value),
    delete: (key) => inner.delete(key),
    claim: (key, owner, leaseMs) => inner.claim(key, owner, leaseMs),
    renew: (key, owner, leaseMs) => inner.renew(key, owner, leaseMs),
    release: (key, owner) => inner.release(key, owner),
    async put(value) {
      if (value.phase === phase) {
        throw new Error("disk full");
      }
      await inner.put(value);
    },
  };
}

function losingRenew(): TransferStore {
  const inner = new MemoryTransferStore();
  return {
    get: (key) => inner.get(key),
    list: () => inner.list(),
    create: (value) => inner.create(value),
    put: (value) => inner.put(value),
    delete: (key) => inner.delete(key),
    claim: (key, owner, leaseMs) => inner.claim(key, owner, leaseMs),
    renew: async () => false,
    release: (key, owner) => inner.release(key, owner),
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
      sourceAddress: "0x1111111111111111111111111111111111111111",
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

  it("records the Stellar public key as the source address", async () => {
    const store = new MemoryTransferStore();
    const params = {
      from: "stellar",
      to: "arc",
      amount: "10",
      recipient: "0x2222222222222222222222222222222222222222",
      speed: "standard",
      signer: { publicKey: "GSOURCE" },
    } as unknown as TransferParams;

    const outcome = await executeTransfer(
      kernel(async () => result()),
      store,
      params,
      { idempotencyKey: "order-2" },
    );

    expect(outcome.record.sourceAddress).toBe("GSOURCE");
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

  it("reconstructs a missing result for a terminal record", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({
        phase: "minted",
        burnTxHash: "burn-1",
        attestationHash: "0xattestation",
        mintTxHash: "mint-1",
        transferMode: "fast",
        fee: "0.2",
        updatedAt: 500,
      }),
    );
    let calls = 0;

    const outcome = await executeTransfer(
      kernel(async () => {
        calls += 1;
        return result();
      }),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    );

    expect(calls).toBe(0);
    expect(outcome.result).toMatchObject({
      status: "success",
      transferMode: "fast",
      fee: "0.2",
      burnTxHash: "burn-1",
      attestationHash: "0xattestation",
      mintTxHash: "mint-1",
      durationMs: 499,
    });
    expect((await store.get("order-1"))?.result).toEqual(outcome.result);
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
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
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

  it("rejects reuse of a key for a different transfer", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ amount: "99" }));
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
      reason: "mismatch",
      record: { amount: "99" },
    });
    expect(calls).toBe(0);
  });

  it("rejects reuse of a key from a different source account", async () => {
    const store = new MemoryTransferStore();
    await store.create(
      record({
        phase: "minted",
        sourceAddress: "0x1111111111111111111111111111111111111111",
        result: result(),
      }),
    );
    const otherSource = {
      ...PARAMS,
      signer: {
        walletClient: {
          account: { address: "0x2222222222222222222222222222222222222222" },
        },
      },
    } as unknown as TransferParams;

    await expect(
      executeTransfer(
        kernel(async () => result()),
        store,
        otherSource,
        {
          idempotencyKey: "order-1",
        },
      ),
    ).rejects.toMatchObject({ reason: "mismatch" });
  });

  it.each(["burned", "attesting", "attested", "recoverable"] as const)(
    "resumes a %s transfer through completeMint",
    async (phase) => {
      const store = new MemoryTransferStore();
      await store.create(
        record({
          phase,
          burnTxHash: "burn-9",
          attestationHash: "0xattestation",
          transferMode: "fast",
          fee: "0.25",
          error: "attestation is not ready",
        }),
      );
      let transferCalls = 0;
      let mintCalls = 0;
      let seen: CompleteMintParams | undefined;
      const client = kernel(
        async () => {
          transferCalls += 1;
          return result();
        },
        async (params) => {
          mintCalls += 1;
          seen = params;
          return {
            mintTxHash: "mint-9",
            attestationHash: "0xattestation",
          };
        },
      );

      const outcome = await executeTransfer(
        client,
        store,
        PARAMS_WITH_DESTINATION,
        { idempotencyKey: "order-1" },
      );

      expect(transferCalls).toBe(0);
      expect(mintCalls).toBe(1);
      expect(seen).toMatchObject({
        from: "arc",
        to: "stellar",
        burnTxHash: "burn-9",
        network: "mainnet",
        signer: DESTINATION_SIGNER,
      });
      expect(outcome.result).toMatchObject({
        status: "success",
        transferMode: "fast",
        fee: "0.25",
        burnTxHash: "burn-9",
        attestationHash: "0xattestation",
        mintTxHash: "mint-9",
      });
      expect(outcome.record).toMatchObject({
        phase: "minted",
        burnTxHash: "burn-9",
        mintTxHash: "mint-9",
      });
      expect(outcome.record.error).toBeUndefined();
      expect(await store.get("order-1")).toEqual(outcome.record);
    },
  );

  it("requires a destination signer before resuming", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "recoverable", burnTxHash: "burn-9" }));
    let mintCalls = 0;

    const err = await executeTransfer(
      kernel(
        async () => result(),
        async () => {
          mintCalls += 1;
          return { mintTxHash: "mint-9", attestationHash: "0xattestation" };
        },
      ),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(TransferConflictError);
    expect(err).toMatchObject({ reason: "recoverable" });
    expect(mintCalls).toBe(0);
  });

  it("keeps a failed resume recoverable", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "recoverable", burnTxHash: "burn-9" }));
    const failure = new AttestationNotReadyError("still pending", "burn-9");

    const err = await executeTransfer(
      kernel(
        async () => result(),
        async () => {
          throw failure;
        },
      ),
      store,
      PARAMS_WITH_DESTINATION,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBe(failure);
    expect(await store.get("order-1")).toMatchObject({
      phase: "recoverable",
      burnTxHash: "burn-9",
      error: "still pending",
    });
  });

  it("does not resume an indeterminate mint", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "minting", burnTxHash: "burn-9" }));
    let mintCalls = 0;

    const err = await executeTransfer(
      kernel(
        async () => result(),
        async () => {
          mintCalls += 1;
          return { mintTxHash: "mint-9", attestationHash: "0xattestation" };
        },
      ),
      store,
      PARAMS_WITH_DESTINATION,
      { idempotencyKey: "order-1" },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(TransferConflictError);
    expect(err).toMatchObject({ reason: "in_progress" });
    expect(mintCalls).toBe(0);
  });

  it("persists kernel progress before the final result", async () => {
    const store = new MemoryTransferStore();
    const client = kernel(async (_params, runOptions) => {
      await runOptions?.onProgress?.({
        phase: "burned",
        burnTxHash: "burn-progress",
        transferMode: "fast",
        fee: "0.5",
      });
      throw new Error("mint crash");
    });

    const err = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    }).catch((error) => error);

    expect(err).toBeInstanceOf(Error);
    expect(await store.get("order-1")).toMatchObject({
      phase: "failed",
      burnTxHash: "burn-progress",
      transferMode: "fast",
      fee: "0.5",
      error: "mint crash",
    });
  });

  it("unwraps a progress persistence failure from the kernel", async () => {
    const store = failingPut("burned");
    const client = kernel(async (_params, runOptions) => {
      try {
        await runOptions?.onProgress?.({
          phase: "burned",
          burnTxHash: "burn-9",
        });
      } catch (err) {
        throw new TransferProgressError(err);
      }
      return result();
    });

    const err = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    }).catch((error) => error);

    expect(err).toBeInstanceOf(TransferPersistenceError);
    expect(err).toMatchObject({
      record: { phase: "burned", burnTxHash: "burn-9" },
    });
  });

  it("releases the lease after a successful transfer", async () => {
    const store = new MemoryTransferStore();

    await executeTransfer(
      kernel(async () => result()),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    );

    await expect(
      store.claim("order-1", "other", 60_000),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  it("releases the lease after a failed transfer", async () => {
    const store = new MemoryTransferStore();

    await executeTransfer(
      kernel(async () => {
        throw new Error("burn rejected");
      }),
      store,
      PARAMS,
      { idempotencyKey: "order-1" },
    ).catch(() => undefined);

    await expect(
      store.claim("order-1", "other", 60_000),
    ).resolves.toMatchObject({ status: "claimed" });
  });

  it("blocks a resumable transfer while another owner holds the lease", async () => {
    const store = new MemoryTransferStore();
    await store.create(record({ phase: "recoverable", burnTxHash: "burn-9" }));
    await store.claim("order-1", "other", 60_000);
    let mintCalls = 0;

    const err = await executeTransfer(
      kernel(
        async () => result(),
        async () => {
          mintCalls += 1;
          return { mintTxHash: "mint-9", attestationHash: "0xattestation" };
        },
      ),
      store,
      PARAMS_WITH_DESTINATION,
      { idempotencyKey: "order-1", owner: "me" },
    ).catch((error) => error);

    expect(err).toBeInstanceOf(TransferConflictError);
    expect(err).toMatchObject({ reason: "in_progress" });
    expect(mintCalls).toBe(0);
  });

  it("renews the lease as progress is persisted", async () => {
    const store = new MemoryTransferStore();
    const renew = vi.spyOn(store, "renew");
    const client = kernel(async (_params, runOptions) => {
      await runOptions?.onProgress?.({
        phase: "burned",
        burnTxHash: "burn-1",
      });
      return result();
    });

    await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    });

    expect(renew).toHaveBeenCalled();
  });

  it("stops when the lease is lost during progress", async () => {
    const store = losingRenew();
    const client = kernel(async (_params, runOptions) => {
      try {
        await runOptions?.onProgress?.({
          phase: "burned",
          burnTxHash: "burn-1",
        });
      } catch (err) {
        throw new TransferProgressError(err);
      }
      return result();
    });

    const err = await executeTransfer(client, store, PARAMS, {
      idempotencyKey: "order-1",
    }).catch((error) => error);

    expect(err).toBeInstanceOf(TransferLeaseLostError);
  });
});
