#!/usr/bin/env node
// End-to-end smoke test of the operations layer against live Arc and Stellar testnets.
// It runs one real Arc to Stellar transfer through the durable runtime backed by a remote
// store server, then reads it back through the HTTP API, replays it from a second client,
// runs the indexer sync wrappers against live RPC, and delivers a signed webhook to a local
// receiver. Requires funded testnet keys and a built package, like scripts/testnet-smoke.mjs.
//
// The indexers are exercised for live reads, ledger hash verification, and cursor
// persistence. The transfer is already minted when they run, so they report no candidates.

import { createServer } from "node:http";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { arcTestnetChain } from "../dist/index.js";
import { createApiServer, createStoreServer } from "../dist/api.js";
import { createSettlementRuntime } from "../dist/runtime.js";
import {
  MemoryTransferStore,
  RemoteTransferStore,
} from "../dist/execution/index.js";
import {
  MemoryIndexerCursorStore,
  RemoteIndexerCursorStore,
} from "../dist/indexer/index.js";
import {
  MemoryWebhookDeliveryStore,
  WebhookDispatcher,
  transferWebhookEvent,
  verifyWebhookSignature,
} from "../dist/webhooks/index.js";

const ARC_PRIVATE_KEY = process.env.ARC_PRIVATE_KEY;
const STELLAR_SECRET_KEY = process.env.STELLAR_SECRET_KEY;
const SMOKE_AMOUNT = process.env.SMOKE_AMOUNT ?? "1.00";
const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const TOKEN = "ops-smoke-token";
const WEBHOOK_SECRET = "ops-smoke-webhook-secret";

if (!ARC_PRIVATE_KEY || !STELLAR_SECRET_KEY) {
  console.error(
    "Missing ARC_PRIVATE_KEY and/or STELLAR_SECRET_KEY. See scripts/testnet-smoke.mjs.",
  );
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} ${detail}`);
  }
}

const arcAccount = privateKeyToAccount(ARC_PRIVATE_KEY);
const arcSigner = {
  walletClient: createWalletClient({
    account: arcAccount,
    chain: arcTestnetChain,
    transport: http(),
  }),
};
const stellarKeypair = Keypair.fromSecret(STELLAR_SECRET_KEY);
const stellarSigner = {
  publicKey: stellarKeypair.publicKey(),
  keypair: stellarKeypair,
};

const arcClient = createPublicClient({
  chain: arcTestnetChain,
  transport: http(),
});

const arcStartBlock = await arcClient.getBlockNumber();
const latestLedgerResponse = await fetch(STELLAR_RPC_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
});
const stellarStartLedger = (await latestLedgerResponse.json()).result.sequence;
console.log(
  `Start positions: Arc block ${arcStartBlock}, Stellar ledger ${stellarStartLedger}`,
);

const authority = createStoreServer({
  transferStore: new MemoryTransferStore(),
  cursorStore: new MemoryIndexerCursorStore(),
  port: 0,
  token: TOKEN,
});
const authorityAddress = await authority.listen();
const clientOptions = { url: authorityAddress.url, token: TOKEN };
const storeA = new RemoteTransferStore(clientOptions);
const storeB = new RemoteTransferStore(clientOptions);
const cursorStore = new RemoteIndexerCursorStore(clientOptions);
const runtimeA = createSettlementRuntime(storeA);
const runtimeB = createSettlementRuntime(storeB);

const api = createApiServer({
  store: storeB,
  cursorStore,
  port: 0,
  token: TOKEN,
});
const apiAddress = await api.listen();

const received = [];
const receiver = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.statusCode = 204;
    response.end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

try {
  const key = `ops-smoke-${Date.now()}`;
  const params = {
    from: "arc",
    to: "stellar",
    amount: SMOKE_AMOUNT,
    recipient: stellarKeypair.publicKey(),
    speed: "standard",
    signer: arcSigner,
    network: "testnet",
    options: {
      destinationSigner: stellarSigner,
      stellarRpcUrl: STELLAR_RPC_URL,
    },
  };

  console.log("\n--- durable transfer through the remote store ---");
  const outcome = await runtimeA.execute(params, { idempotencyKey: key });
  console.log(JSON.stringify(outcome.result, null, 2));
  check("transfer reaches success", outcome.result.status === "success");
  check("record is minted", outcome.record.phase === "minted");
  check("mint hash recorded", Boolean(outcome.result.mintTxHash));

  console.log("\n--- store server holds the record ---");
  const stored = await storeB.get(key);
  check(
    "second client reads the same record",
    stored?.burnTxHash === outcome.result.burnTxHash &&
      stored?.phase === "minted",
  );

  console.log("\n--- HTTP operations API ---");
  const health = await fetch(`${apiAddress.url}/health`);
  check("api health is public", health.status === 200);
  const denied = await fetch(`${apiAddress.url}/transfers/${key}`);
  check("api rejects a missing token", denied.status === 401);
  const read = await fetch(`${apiAddress.url}/transfers/${key}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const readBody = await read.json();
  check("api returns the minted record", read.status === 200);
  check(
    "api record matches the transfer",
    JSON.stringify(readBody).includes(outcome.result.burnTxHash),
  );

  console.log("\n--- replay from a second client ---");
  const replay = await runtimeB.execute(params, { idempotencyKey: key });
  check(
    "replay returns the original burn",
    replay.result.burnTxHash === outcome.result.burnTxHash,
  );
  check(
    "replay returns the original mint",
    replay.result.mintTxHash === outcome.result.mintTxHash,
  );

  console.log("\n--- indexers against live RPC ---");
  const arcSync = await runtimeA.syncArcBurns({
    network: "testnet",
    startBlock: arcStartBlock,
    confirmations: 0,
    cursorStore,
    stream: "ops-smoke-arc-burns",
  });
  check(
    "arc burn sync scans the transfer range",
    arcSync.toBlock >= arcSync.fromBlock && arcSync.cursor !== undefined,
  );
  const arcSecond = await runtimeA.syncArcBurns({
    network: "testnet",
    startBlock: arcStartBlock,
    confirmations: 0,
    cursorStore,
    stream: "ops-smoke-arc-burns",
  });
  check(
    "arc burn sync resumes from the saved cursor",
    arcSecond.fromBlock >= arcSync.toBlock,
  );
  try {
    const stellarSync = await runtimeA.syncStellarMints({
      network: "testnet",
      startLedger: stellarStartLedger,
      rpcUrl: STELLAR_RPC_URL,
      cursorStore,
      stream: "ops-smoke-stellar-mints",
    });
    check(
      "stellar mint sync verifies ledgers and saves a cursor",
      stellarSync.cursor !== undefined,
    );
    const savedCursor = await cursorStore.get("ops-smoke-stellar-mints");
    check(
      "cursor is stored on the store server",
      savedCursor !== undefined && savedCursor !== null,
    );
  } catch (error) {
    check(
      "stellar mint sync completes",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }

  console.log("\n--- signed webhook delivery ---");
  const dispatcher = new WebhookDispatcher({
    endpoints: [{ id: "ops-smoke", url: receiverUrl, secret: WEBHOOK_SECRET }],
    store: new MemoryWebhookDeliveryStore(),
    maxAttempts: 2,
  });
  await dispatcher.enqueue(transferWebhookEvent(outcome.record));
  await dispatcher.dispatchDue();
  check("receiver got one delivery", received.length === 1);
  const delivery = received[0];
  check(
    "signature verifies",
    delivery !== undefined &&
      verifyWebhookSignature({
        secret: WEBHOOK_SECRET,
        header: delivery.headers["x-parabola-signature"],
        body: delivery.body,
      }),
  );
  check(
    "payload carries the burn hash",
    delivery?.body.includes(outcome.result.burnTxHash) === true,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL unexpected error:", error);
} finally {
  await api.close();
  await authority.close();
  await new Promise((resolve) => receiver.close(resolve));
}

if (failures > 0) {
  console.error(`\n${failures} ops smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll ops smoke checks passed.");
