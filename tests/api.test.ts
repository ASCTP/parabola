import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiServer,
  type ApiAddress,
  type ApiRuntime,
  type ApiServer,
  type ApiServerOptions,
} from "../src/api.js";
import type { TransferRecord } from "../src/execution/contracts.js";
import { MemoryTransferStore } from "../src/execution/memory-store.js";
import { MemoryIndexerCursorStore } from "../src/indexer/cursor.js";

const RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";
const TOKEN = "secret";

const EMPTY_SUMMARY = {
  reconciled: [],
  unmatched: [],
  ambiguous: [],
  skipped: [],
  busy: [],
};

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

function runtime(overrides: Partial<ApiRuntime> = {}): ApiRuntime {
  return {
    reconcile: vi.fn().mockResolvedValue({
      record: record({ phase: "burned" }),
      changed: true,
    }),
    indexArcBurns: vi.fn().mockResolvedValue(EMPTY_SUMMARY),
    indexArcMints: vi.fn().mockResolvedValue(EMPTY_SUMMARY),
    indexStellarBurns: vi.fn().mockResolvedValue(EMPTY_SUMMARY),
    indexStellarMints: vi.fn().mockResolvedValue(EMPTY_SUMMARY),
    syncArcBurns: vi.fn().mockResolvedValue({
      summary: EMPTY_SUMMARY,
      fromBlock: 1n,
      toBlock: 2n,
      rewound: false,
    }),
    syncArcMints: vi.fn().mockResolvedValue({
      summary: EMPTY_SUMMARY,
      fromBlock: 1n,
      toBlock: 2n,
      rewound: false,
    }),
    syncStellarBurns: vi.fn().mockResolvedValue({
      summary: EMPTY_SUMMARY,
      fromLedger: 1,
      toLedger: 2,
    }),
    syncStellarMints: vi.fn().mockResolvedValue({
      summary: EMPTY_SUMMARY,
      fromLedger: 1,
      toLedger: 2,
    }),
    ...overrides,
  } as ApiRuntime;
}

const servers: ApiServer[] = [];

async function start(
  overrides: Partial<ApiServerOptions> = {},
): Promise<{
  api: ApiServer;
  address: ApiAddress;
  store: MemoryTransferStore;
  cursorStore: MemoryIndexerCursorStore;
}> {
  const store =
    (overrides.store as MemoryTransferStore | undefined) ??
    new MemoryTransferStore();
  const cursorStore =
    (overrides.cursorStore as MemoryIndexerCursorStore | undefined) ??
    new MemoryIndexerCursorStore();
  const api = createApiServer({
    store,
    cursorStore,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    runtime: runtime(),
    ...overrides,
  });
  servers.push(api);
  return { api, address: await api.listen(), store, cursorStore };
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
}

async function getJson(url: string, init?: RequestInit): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("HTTP operations API", () => {
  it("answers health without authentication", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/health`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("rejects unauthenticated operations", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/transfers`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("lists stored transfers", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const { address } = await start({ store });

    const response = await getJson(`${address.url}/transfers`, {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transfers: [{ idempotencyKey: "order-1" }],
    });
  });

  it("returns 404 for an unknown transfer", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/transfers/missing`, {
      headers: headers(),
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("was not found"),
    });
  });

  it("reconciles evidence through the runtime", async () => {
    const source = runtime();
    const store = new MemoryTransferStore();
    await store.create(record());
    const { address } = await start({ store, runtime: source });

    const response = await getJson(
      `${address.url}/transfers/order-1/reconcile`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ burnTxHash: "burn-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ changed: true });
    expect(source.reconcile).toHaveBeenCalledWith({
      idempotencyKey: "order-1",
      evidence: { burnTxHash: "burn-1" },
    });
  });

  it("maps missing reconcile evidence to 400", async () => {
    const store = new MemoryTransferStore();
    await store.create(record());
    const { address } = await start({ store, runtime: undefined });

    const response = await getJson(
      `${address.url}/transfers/order-1/reconcile`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("a burn or mint transaction hash is required"),
    });
  });

  it("rejects malformed JSON", async () => {
    const { address } = await start();

    const response = await getJson(
      `${address.url}/transfers/order-1/reconcile`,
      {
        method: "POST",
        headers: headers(),
        body: "{",
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Request body is not valid JSON",
    });
  });

  it("requires a JSON content type", async () => {
    const { address } = await start();

    const response = await getJson(
      `${address.url}/transfers/order-1/reconcile`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{}",
      },
    );

    expect(response.status).toBe(415);
  });

  it("rejects an oversized body", async () => {
    const { address } = await start({ maxBodyBytes: 5 });

    const response = await getJson(
      `${address.url}/transfers/order-1/reconcile`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ burnTxHash: "burn-1" }),
      },
    );

    expect(response.status).toBe(413);
  });

  it("indexes an Arc block range", async () => {
    const source = runtime();
    const { address } = await start({ runtime: source });

    const response = await getJson(`${address.url}/index/arc/burns`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "mainnet",
        fromBlock: "10",
        toBlock: 20,
      }),
    });

    expect(response.status).toBe(200);
    expect(source.indexArcBurns).toHaveBeenCalledWith({
      network: "mainnet",
      fromBlock: 10n,
      toBlock: 20n,
      rpcUrl: undefined,
    });
  });

  it("indexes a Stellar ledger range", async () => {
    const source = runtime();
    const { address } = await start({ runtime: source });

    const response = await getJson(`${address.url}/index/stellar/mints`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "testnet",
        startLedger: 1,
        endLedger: 2,
      }),
    });

    expect(response.status).toBe(200);
    expect(source.indexStellarMints).toHaveBeenCalledWith({
      network: "testnet",
      startLedger: 1,
      endLedger: 2,
      rpcUrl: undefined,
    });
  });

  it("advances an Arc cursor", async () => {
    const source = runtime();
    const { address, cursorStore } = await start({ runtime: source });

    const response = await getJson(`${address.url}/sync/arc/burns`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "mainnet",
        startBlock: "10",
        confirmations: 2,
        reorgWindow: "1",
      }),
    });

    expect(response.status).toBe(200);
    expect(source.syncArcBurns).toHaveBeenCalledWith({
      network: "mainnet",
      startBlock: 10n,
      confirmations: 2,
      reorgWindow: 1n,
      rpcUrl: undefined,
      stream: undefined,
      cursorStore,
    });
  });

  it("advances a Stellar cursor", async () => {
    const source = runtime();
    const { address, cursorStore } = await start({ runtime: source });

    const response = await getJson(`${address.url}/sync/stellar/burns`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "mainnet",
        startLedger: 5,
        stream: "custom",
      }),
    });

    expect(response.status).toBe(200);
    expect(source.syncStellarBurns).toHaveBeenCalledWith({
      network: "mainnet",
      startLedger: 5,
      rpcUrl: undefined,
      stream: "custom",
      cursorStore,
    });
  });

  it("rejects an invalid network", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/index/arc/burns`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "devnet",
        fromBlock: 1,
        toBlock: 2,
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "network must be mainnet or testnet",
    });
  });

  it("rejects an invalid block number", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/index/arc/burns`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        network: "mainnet",
        fromBlock: -1,
        toBlock: 2,
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "fromBlock must be a non-negative integer",
    });
  });

  it("returns 404 for an unknown route", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/nope`, {
      headers: headers(),
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });

  it("returns 405 for a wrong method", async () => {
    const { address } = await start();

    const response = await getJson(`${address.url}/transfers`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });

    expect(response.status).toBe(405);
    expect(response.body).toEqual({ error: "Method not allowed" });
  });
});
