import { afterEach, describe, expect, it } from "vitest";
import type { TransferRecord } from "../../src/execution/contracts.js";
import { MemoryTransferStore } from "../../src/execution/memory-store.js";
import { RemoteTransferStore } from "../../src/execution/remote-store.js";
import type { IndexerCursor } from "../../src/indexer/cursor.js";
import { MemoryIndexerCursorStore } from "../../src/indexer/cursor.js";
import { RemoteIndexerCursorStore } from "../../src/indexer/remote-cursor-store.js";
import { MemoryMetrics } from "../../src/observability.js";
import {
  createStoreServer,
  type StoreServer,
  type StoreServerOptions,
} from "../../src/store-server.js";

const servers: StoreServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function record(
  idempotencyKey: string,
  overrides: Partial<TransferRecord> = {},
): TransferRecord {
  return {
    idempotencyKey,
    phase: "planned",
    from: "arc",
    to: "stellar",
    network: "testnet",
    amount: "1000000",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function cursor(
  stream: string,
  overrides: Partial<IndexerCursor> = {},
): IndexerCursor {
  return {
    stream,
    blockNumber: 42n,
    blockHash: `0x${"11".repeat(32)}`,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function start(
  overrides: Partial<StoreServerOptions> = {},
): Promise<{ url: string; metrics: MemoryMetrics }> {
  const metrics = new MemoryMetrics();
  const server = createStoreServer({
    transferStore: new MemoryTransferStore(),
    cursorStore: new MemoryIndexerCursorStore(),
    port: 0,
    ...overrides,
    metrics,
  });
  servers.push(server);
  const address = await server.listen();
  return { url: address.url, metrics };
}

describe("remote transfer store", () => {
  it("rejects invalid client urls", () => {
    expect(
      () => new RemoteTransferStore({ url: "ftp://example.com" }),
    ).toThrow(RangeError);
    expect(
      () =>
        new RemoteTransferStore({
          url: "http://example.com?tenant=a",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new RemoteTransferStore({
          url: "http://user:secret@example.com",
        }),
    ).toThrow(RangeError);
  });

  it("coordinates records and leases across clients", async () => {
    const { url } = await start();
    const first = new RemoteTransferStore({ url });
    const second = new RemoteTransferStore({ url });
    const transfer = record("order-1");

    await expect(first.create(transfer)).resolves.toBe(true);
    await expect(first.create(transfer)).resolves.toBe(false);
    await expect(second.get("order-1")).resolves.toEqual(transfer);
    await expect(second.list()).resolves.toEqual([transfer]);

    await expect(
      first.claim("order-1", "owner-a", 1_000),
    ).resolves.toEqual({ status: "claimed", record: transfer });
    await expect(
      second.claim("order-1", "owner-b", 1_000),
    ).resolves.toEqual({ status: "busy", record: transfer });
    await expect(
      first.renew("order-1", "owner-a", 1_000),
    ).resolves.toBe(true);
    await expect(
      second.renew("order-1", "owner-b", 1_000),
    ).resolves.toBe(false);

    await second.release("order-1", "owner-b");
    await expect(
      second.claim("order-1", "owner-b", 1_000),
    ).resolves.toEqual({ status: "busy", record: transfer });

    await first.release("order-1", "owner-a");
    await expect(
      second.claim("order-1", "owner-b", 1_000),
    ).resolves.toEqual({ status: "claimed", record: transfer });
  });

  it("updates and deletes records", async () => {
    const { url } = await start();
    const store = new RemoteTransferStore({ url });
    await store.create(record("order-1"));

    await store.put(record("order-1", { phase: "burning" }));
    await expect(store.get("order-1")).resolves.toMatchObject({
      phase: "burning",
    });

    await store.delete("order-1");
    await expect(store.get("order-1")).resolves.toBeUndefined();
    await expect(store.delete("order-1")).resolves.toBeUndefined();
  });

  it("returns undefined for an unknown record", async () => {
    const { url } = await start();
    const store = new RemoteTransferStore({ url });

    await expect(store.get("missing")).resolves.toBeUndefined();
  });

  it("encodes unsafe keys in request paths", async () => {
    const { url } = await start();
    const store = new RemoteTransferStore({ url });
    const transfer = record("../order:1?batch=a/b");

    await store.create(transfer);

    await expect(
      store.get(transfer.idempotencyKey),
    ).resolves.toEqual(transfer);
    await store.delete(transfer.idempotencyKey);
    await expect(
      store.get(transfer.idempotencyKey),
    ).resolves.toBeUndefined();
  });

  it("requires a bearer token when configured", async () => {
    const { url } = await start({ token: "secret" });
    const anonymous = new RemoteTransferStore({ url });
    const authenticated = new RemoteTransferStore({
      url,
      token: "secret",
    });

    await expect(anonymous.get("order-1")).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      authenticated.get("order-1"),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid claim and record bodies", async () => {
    const { url } = await start();
    const store = new RemoteTransferStore({ url });

    await expect(
      store.claim("order-1", "owner-a", 0),
    ).rejects.toMatchObject({ status: 400 });

    const response = await fetch(`${url}/transfers/order-1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record("other")),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "idempotencyKey must match the request path",
    });
  });

  it("rejects malformed JSON and the wrong content type", async () => {
    const { url } = await start();

    const malformed = await fetch(`${url}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const wrongType = await fetch(`${url}/transfers`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
  });

  it("records request metrics", async () => {
    const { url, metrics } = await start();
    const store = new RemoteTransferStore({ url });

    await store.list();

    expect(metrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "parabola_store_requests_total",
          labels: {
            method: "GET",
            route: "/transfers",
            status: "200",
          },
        }),
        expect.objectContaining({
          name: "parabola_store_request_duration_ms",
        }),
      ]),
    );
  });
});

describe("remote indexer cursor store", () => {
  it("round trips a bigint cursor across clients", async () => {
    const { url } = await start();
    const first = new RemoteIndexerCursorStore({ url });
    const second = new RemoteIndexerCursorStore({ url });
    const value = cursor("arc:burns");

    await expect(first.get("arc:burns")).resolves.toBeUndefined();
    await first.put(value);

    await expect(second.get("arc:burns")).resolves.toEqual(value);

    await second.delete("arc:burns");
    await expect(first.get("arc:burns")).resolves.toBeUndefined();
    await expect(second.delete("arc:burns")).resolves.toBeUndefined();
  });

  it("rejects a stream that does not match the path", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/cursors/arc:burns`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        cursor("stellar:burns"),
        (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
      ),
    });

    expect(response.status).toBe(400);
  });

  it("rejects when the server has no cursor store", async () => {
    const { url } = await start({ cursorStore: undefined });
    const store = new RemoteIndexerCursorStore({ url });

    await expect(store.get("arc:burns")).rejects.toMatchObject({
      status: 501,
    });
  });
});

describe("store server routes", () => {
  it("serves health without authentication", async () => {
    const { url } = await start({ token: "secret" });
    const response = await fetch(`${url}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns 404 for an unknown route", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/missing`);

    expect(response.status).toBe(404);
  });

  it("returns 405 for an unsupported method", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/transfers`, {
      method: "PATCH",
    });

    expect(response.status).toBe(405);
  });
});
