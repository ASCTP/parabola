# Parabola

Parabola is a developer platform for the Arc&harr;Stellar USDC corridor. Today that means an SDK,
a durable execution runtime, chain-event indexing, an operator CLI and HTTP API, provider
conformance tooling, and signed webhook delivery with endpoint management and replay. Gas abstraction and additional CCTP domains
are the direction it is headed as the corridor sees real usage. That is a lens on where this
goes, not a committed timeline.

The SDK is a TypeScript library for moving native USDC between Circle's Arc network and Stellar
using CCTP V2. It exists because Stellar is the odd one out in Circle's CCTP ecosystem: inbound
transfers must route through a `CctpForwarder` contract instead of minting directly, Stellar
addresses use a different encoding than every other CCTP chain, and Stellar's USDC has different
decimal precision than Arc's. Parabola handles all of that internally so a developer calls one
`transfer()` function instead of hand-rolling the burn-attest-mint flow across two chains with
different data models.

## Installation

```bash
npm install @asctp/parabola
```

Parabola declares `@stellar/stellar-sdk@^16.2.0` and `viem@^2.21.0` as dependencies. You only need to think about the Stellar one: constructing a `StellarSigner` from a `Keypair` means naming that type in your own code, so import it from Parabola rather than installing a second copy.

```typescript
import { Keypair } from "@asctp/parabola";
```

Two copies of `@stellar/stellar-sdk` at different versions produce structurally similar but distinct `Keypair` types. TypeScript will not reconcile them, and the mismatch surfaces only in the signing path at runtime.

## Choosing a network

Every entry point (`transfer`, `estimateFee`, `completeMint`, `checkStellarRecipientReady`) accepts an optional `network` parameter: `"mainnet"` or `"testnet"`. It defaults to `"mainnet"`.

Mainnet moves real USDC and spends real Arc gas on every transfer. A caller that does not pass `network` transacts on mainnet. Pass `network: "testnet"` to run against Arc and Stellar testnet with faucet funds (fund via [faucet.circle.com](https://faucet.circle.com)) during development.

```typescript
// Development against testnet, no real funds
const result = await transfer({ /* ... */, network: "testnet" });

// Production, moves real USDC (this is the default when network is omitted)
const result = await transfer({ /* ... */, network: "mainnet" });
```

The network selects the contract addresses, RPC endpoints, and Circle Iris environment used internally. Both examples below pass `network: "mainnet"` explicitly; drop it and the behavior is identical.

The Stellar Soroban RPC defaults to `https://mainnet.sorobanrpc.com` on mainnet and `https://soroban-testnet.stellar.org` on testnet. Override it per call with `options.stellarRpcUrl` (recommended on mainnet, where a dedicated or paid RPC is more reliable than the public default). `options.arcRpcUrl` does the same for the Arc endpoint Parabola uses to read transaction receipts; it does not replace the signer's own transport, which is what broadcasts.

If you are wiring this into a long-running service, default your own configuration to testnet and make mainnet an explicit opt-in, then reject any request whose `network` disagrees with it. The mainnet default is convenient for a script and is the wrong failure mode for a process holding a funded key.

## Arc to Stellar

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcMainnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as `0x${string}`);
const arcSigner: ArcSigner = {
  walletClient: createWalletClient({
    account: arcAccount,
    chain: arcMainnetChain,
    transport: http(),
  }),
};

const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
const destinationSigner: StellarSigner = {
  publicKey: stellarKeypair.publicKey(),
  keypair: stellarKeypair,
};

const result = await transfer({
  from: "arc",
  to: "stellar",
  amount: "10.50",
  recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
  speed: "fast",
  signer: arcSigner,
  network: "mainnet",
  options: {
    maxFee: "0.05",
    destinationSigner,
  },
});

console.log(result);
// {
//   status: "success",
//   transferMode: "fast",
//   burnTxHash: "0x...",
//   attestationHash: "0x...",
//   mintTxHash: "...",
//   fee: "0.013",
//   durationMs: 14832
// }
```

See [`examples/arc-to-stellar.ts`](examples/arc-to-stellar.ts) for the full working file.

## Stellar to Arc

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcMainnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
const stellarSigner: StellarSigner = {
  publicKey: stellarKeypair.publicKey(),
  keypair: stellarKeypair,
};

const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as `0x${string}`);
const destinationSigner: ArcSigner = {
  walletClient: createWalletClient({
    account: arcAccount,
    chain: arcMainnetChain,
    transport: http(),
  }),
};

const result = await transfer({
  from: "stellar",
  to: "arc",
  amount: "25.00",
  recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  speed: "standard",
  signer: stellarSigner,
  network: "mainnet",
  options: { destinationSigner },
});

console.log(result);
```

See [`examples/stellar-to-arc.ts`](examples/stellar-to-arc.ts) for the full working file.

## Fee estimation

```typescript
import { estimateFee } from "@asctp/parabola";

const estimate = await estimateFee({
  from: "arc",
  to: "stellar",
  amount: "100",
  speed: "fast",
});

console.log(estimate);
// { protocolFee: "0.01", estimatedDurationSeconds: 15, transferMode: "fast" }
```

## How it works

Every transfer follows CCTP V2's burn-attest-mint flow:

1. **Burn.** Parabola calls `depositForBurn` (or, when the destination is Stellar, `depositForBurnWithHook`) on the source chain, locking the USDC out of circulation there.
2. **Attest.** Circle's Iris service observes the burn and, once the source chain reaches the required finality threshold, signs an attestation. Parabola polls Iris for you (`pollInterval`/`pollTimeout` are configurable) instead of you writing that loop yourself.
3. **Mint.** Parabola submits the attested message to the destination chain: `receiveMessage` on Arc, or, for Stellar, `mint_and_forward` on Circle's `CctpForwarder` contract, which mints to itself and then forwards to the real recipient. Direct minting to a Stellar address is not supported by CCTP, which is why the forwarder step exists.

Along the way, Parabola also:

- Translates Stellar `G...`/`C...` addresses into the 32-byte format CCTP messages require, and encodes the forward-recipient hook Stellar-bound transfers need.
- Converts between Stellar USDC's 7-decimal precision and Arc USDC's 6-decimal precision, so you always work in human-readable amounts like `"10.50"`. See [Amounts and decimals](#amounts-and-decimals).
- Picks Standard or Fast transfer based on `speed`, quotes the Fast fee from Circle's fees endpoint first, and falls back to Standard automatically if the quoted fee exceeds `maxFee`.

### Completing the mint: `destinationSigner` and `completeMint`

`receiveMessage` and `mint_and_forward` are permissionless CCTP calls, but submitting them still costs gas natively on the destination chain, and Parabola never holds keys on your behalf. Pass `options.destinationSigner` with a signer for the *destination* chain to have Parabola submit that step automatically as part of the single `transfer()` call. The direction decides the type: an Arc-to-Stellar transfer takes a `StellarSigner` here and a Stellar-to-Arc transfer takes an `ArcSigner`, so naming the wrong chain fails to typecheck instead of failing after the burn.

If you omit `destinationSigner` (for example, your backend only holds the source chain's key at call time), `transfer()` performs the burn and attestation polling and returns `status: "pending"` with `mintTxHash: ""`. Finish the transfer later, from wherever the destination key lives, with `completeMint()`:

```typescript
import { completeMint } from "@asctp/parabola";

const { mintTxHash, attestationHash } = await completeMint({
  from: "arc",
  to: "stellar",
  burnTxHash: result.burnTxHash,
  signer: destinationSigner, // a StellarSigner, since "to" is Stellar
});
```

`completeMint` takes the same polling and RPC knobs as `transfer`, under `options`:

```typescript
await completeMint({
  from: "arc",
  to: "stellar",
  burnTxHash,
  signer: destinationSigner,
  options: {
    pollInterval: 3000,   // ms between Iris polls, default 3000
    pollTimeout: 30_000,  // ms before polling gives up, default 300000
    stellarRpcUrl: process.env.STELLAR_RPC_URL,
    arcRpcUrl: process.env.ARC_RPC_URL,
  },
});
```

`pollInterval`, `pollTimeout`, `stellarRpcUrl` and `arcRpcUrl` are also accepted at the top level for compatibility with earlier releases. When both shapes are present, `options` wins.

## Checking a Stellar recipient before you transfer

A Stellar account doesn't exist on-ledger until it's funded with the minimum XLM reserve, and it can't hold USDC until it also has a USDC trustline. When the destination of a transfer is Stellar, `transfer()` checks both automatically before submitting anything on the source chain, and throws a clear error up front if the recipient isn't ready instead of letting the burn go through and only failing later at the mint step, with the USDC then stuck at the `CctpForwarder` contract.

`completeMint()` performs the same check before it submits, which matters when the burn came from somewhere other than your own `transfer()` call. It does not take the recipient as an argument. It reads the account the mint will actually pay out of the burn message's forward hook, so the check cannot disagree with the destination.

You can also run this check yourself ahead of time, for example to validate a recipient address in a form before a user submits a transfer:

```typescript
import { checkStellarRecipientReady } from "@asctp/parabola";

const status = await checkStellarRecipientReady("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI");
console.log(status);
// { exists: true, hasTrustline: true, ready: true }
```

## Amounts and decimals

`amount`, `maxFee`, and the `fee` on a result are all decimal strings in whole USDC, for example `"10.50"`. Parabola scales them to the source chain's USDC precision internally: 6 decimals on Arc, 7 on Stellar. You never convert units yourself.

Be careful with balances you read outside Parabola, because Arc reports the same USDC at two different scales. `arcMainnetChain.nativeCurrency.decimals` is 18, and `ARC_MAINNET.usdcDecimals` is 6, and these are not two balances in two tokens. Arc's native gas asset is USDC, and the ERC-20 contract at `ARC_MAINNET.usdc` is another view of it. A native balance of 18.99551755 USDC is the same amount as 18.995517 through the ERC-20 contract, the native figure truncated to six places. They move together when USDC is burned or received.

That distinction matters most for a balance floor. A floor expressed in the wrong scale is off by a factor of 10^12, which either disables a transfer direction outright or lets it spend down to nothing without stopping.

| What you are reading | Scale to use |
| --- | --- |
| Arc native balance (`eth_getBalance`, viem's `getBalance`) | `chain.nativeCurrency.decimals`, 18 on Arc |
| Arc USDC ERC-20 (`balanceOf`) | `ARC_MAINNET.usdcDecimals`, 6 |
| Stellar USDC balance | `STELLAR_MAINNET.usdcDecimals`, 7 |
| `TransferParams.amount`, `maxFee`, `FeeEstimate.protocolFee` | Whole USDC, e.g. `"10.50"` |

Prefer reading the scale off the chain object rather than hardcoding it. `decimalsForChain(chain)` resolves the USDC scale for either chain and is the same function `transfer()` uses to interpret `amount`.

## Completing a burn you did not create

`completeMint()` does not need the burn to have come from your own `transfer()` call, and it keeps no record of burns, so it does not check that it did. This is the shape a relayer needs: a caller hands you a `burnTxHash` for a burn produced elsewhere, and you submit the mint on the destination chain.

Before spending anything, read back what the burn committed to:

```typescript
import { resolveBurn } from "@asctp/parabola";

const burn = await resolveBurn({ from: "arc", burnTxHash });
// burn.forwardRecipient is the Stellar account the mint will pay
// burn.amountRaw is in the source chain's USDC subunits (10^6 on Arc)
// burn.attestation is null while Circle is still signing
```

`resolveBurn` returns as soon as Iris has indexed the burn, which is before Circle has signed the attestation, so `attestation` being `null` while `forwardRecipient` is populated is the normal state during the first seconds after a burn. `resolveBurn` throws `AttestationNotReadyError` if Iris has not indexed the burn at all yet.

For a service that must answer its own caller immediately, `getAttestation` performs a single non-blocking read instead of polling to a deadline. A 404 from Iris means the burn is not indexed yet, which is an ordinary early state rather than a failure.

```typescript
import { getAttestation, AttestationNotReadyError } from "@asctp/parabola";

try {
  const message = await getAttestation({ sourceDomain: 26, transactionHash: burnTxHash, useSandbox: false });
  // message.status === "complete" once Circle has signed
} catch (err) {
  if (err instanceof AttestationNotReadyError) {
    // not indexed yet: answer 409 and let the caller come back
  }
  throw err;
}
```

### Idempotency is yours to enforce at the raw SDK layer

The stateless `transfer()` and `completeMint()` entry points do not dedupe. `completeMint()` will submit again for a burn that was already minted. The second submission is rejected on-chain, because CCTP refuses a re-used message, but you pay gas to learn that.

Keep a ledger keyed on the burn hash and network, and return the recorded mint transaction hash for a repeat request instead of resubmitting. If you need to know whether a message was already received for a burn, check Circle's attestation plus the destination chain's own message state rather than calling `completeMint` again to find out.

### Durable execution and indexing

For a service that needs replay-safe execution, leases, and chain-event reconciliation, use the durable runtime subpaths. The root SDK stays stateless; these layers add a store and an operation surface around the same kernel.

```typescript
import { FileTransferStore } from "@asctp/parabola/execution";
import { FileIndexerCursorStore } from "@asctp/parabola/indexer";
import { createSettlementRuntime } from "@asctp/parabola/runtime";

const store = new FileTransferStore(".parabola/transfers");
const runtime = createSettlementRuntime(store);

const { result } = await runtime.execute(params, {
  idempotencyKey: "order-123",
});

await runtime.reconcile({
  idempotencyKey: "order-123",
  evidence: { mintTxHash: "0x..." },
});

const cursors = new FileIndexerCursorStore(".parabola/cursors");
await runtime.syncArcBurns({
  network: "mainnet",
  startBlock: 1_000_000n,
  confirmations: 12,
  cursorStore: cursors,
});
```

`execute()` claims a lease, persists each kernel progress boundary, and replays a completed record for a repeated key. `reconcile()` applies externally observed burn, attestation, or mint evidence without chain I/O. `syncArcBurns()`, `syncArcMints()`, `syncStellarBurns()`, and `syncStellarMints()` advance durable cursors, verify canonical hashes, and scan only the uncovered range.

The file stores are single-host reference implementations. To coordinate several hosts, run one store authority with `createStoreServer()` and point workers at it with the remote stores:

```typescript
import { createStoreServer } from "@asctp/parabola/api";
import {
  FileTransferStore,
  RemoteTransferStore,
} from "@asctp/parabola/execution";
import {
  FileIndexerCursorStore,
  RemoteIndexerCursorStore,
} from "@asctp/parabola/indexer";

const server = createStoreServer({
  transferStore: new FileTransferStore(".parabola/transfers"),
  cursorStore: new FileIndexerCursorStore(".parabola/cursors"),
  token: process.env.PARABOLA_STORE_TOKEN,
});
const address = await server.listen();

const store = new RemoteTransferStore({
  url: address.url,
  token: process.env.PARABOLA_STORE_TOKEN,
});
const cursors = new RemoteIndexerCursorStore({
  url: address.url,
  token: process.env.PARABOLA_STORE_TOKEN,
});
```

The store server centralizes record access and lease claims, so every client observes the same lease. It is a coordination point, not a distributed database. Run one server per store authority, or wrap a shared backend with the same `TransferStore` and `IndexerCursorStore` contracts. It defaults to `127.0.0.1:8788`. Put the server behind your ingress and identity layer; bearer authentication is optional and does not provide TLS.

The sync wrappers advance a cursor even when no candidates exist, so a transfer created after its burn block was scanned needs an explicit cursor reset or backfill.

## Operations API and CLI

The runtime ships with an HTTP server and a terminal client. Both use the same store and cursor contracts as the embedded runtime, so an operator can inspect and repair records without writing a second application.

```typescript
import { createApiServer } from "@asctp/parabola/api";
import { FileTransferStore } from "@asctp/parabola/execution";
import { FileIndexerCursorStore } from "@asctp/parabola/indexer";

const api = createApiServer({
  store: new FileTransferStore(".parabola/transfers"),
  cursorStore: new FileIndexerCursorStore(".parabola/cursors"),
  token: process.env.PARABOLA_API_TOKEN,
  host: "127.0.0.1",
  port: 8787,
});

await api.listen();
```

`GET /health` is unauthenticated and returns `{ "status": "ok" }`. Every other route requires `Authorization: Bearer <token>` when a token is configured. The operations routes are:

| Route | Method | Purpose |
| --- | --- | --- |
| `/transfers` | `GET` | List stored transfer records |
| `/transfers/:idempotencyKey` | `GET` | Read one record |
| `/transfers/:idempotencyKey/reconcile` | `POST` | Apply `burnTxHash`, `attestationHash`, or `mintTxHash` evidence |
| `/index/:chain/:kind` | `POST` | Scan an Arc block range or Stellar ledger range for `burns` or `mints` |
| `/sync/:chain/:kind` | `POST` | Advance a durable cursor for `burns` or `mints` |

Request bodies are JSON objects. Block numbers and ledger numbers accept decimal strings or safe integers, and responses serialize `bigint` values as strings. Invalid input returns `400`, a missing record returns `404`, lease and cursor conflicts return `409`, and unauthenticated operations return `401`.

The CLI is published as the `parabola` bin:

```bash
parabola list --store-dir .parabola/transfers
parabola reconcile --key order-123 --mint-tx 0x...
parabola resolve --from arc --burn-tx 0x...
parabola sync --arc-start-block 1000000 --arc-confirmations 12
parabola sync --stellar-start-ledger 500000 --watch --interval 15000
parabola serve --token "$PARABOLA_API_TOKEN" --port 8787
parabola store --token "$PARABOLA_STORE_TOKEN" --port 8788
```

`--json` prints machine-readable output. `sync --watch` runs the indexer worker on an interval and stops cleanly on `SIGINT` or `SIGTERM`. `serve` and `store` use the same shutdown behavior. `store` starts the remote store server over file backed transfer and cursor stores, and reads its bearer token from `--token` or `PARABOLA_STORE_TOKEN`.

## Observability

`@asctp/parabola/observability` defines the instrumentation boundary. `SettlementMetrics` and `SettlementLogger` are the contracts. `MemoryMetrics`, `MemoryLogger`, and `JsonLogger` are reference implementations for tests, local processes, and structured stdout.

```typescript
import { JsonLogger, MemoryMetrics } from "@asctp/parabola/observability";

const metrics = new MemoryMetrics();
const logger = new JsonLogger();

logger.log({
  level: "info",
  event: "transfer.reconcile.requested",
  timestamp: Date.now(),
  fields: { idempotencyKey: "order-123" },
});
```

The API records `parabola_api_requests_total` and `parabola_api_request_duration_ms` with method, route, and status labels, and can call `onRequest` for every completed request. The store server records `parabola_store_requests_total` and `parabola_store_request_duration_ms` with the same shape. The indexer worker records `parabola_indexer_task_total`, `parabola_indexer_task_duration_ms`, `parabola_indexer_cycle_total`, and `parabola_indexer_cycle_duration_ms`. The webhook dispatcher records `parabola_webhook_enqueued_total`, `parabola_webhook_delivery_attempt_total`, `parabola_webhook_delivery_total`, `parabola_webhook_delivery_duration_ms`, and `parabola_webhook_replay_total`. Pass `metrics` to `createApiServer`, `createStoreServer`, `createIndexerWorker`, or `WebhookDispatcher` to connect a collector.

## Webhooks

`@asctp/parabola/webhooks` delivers transfer events to your own systems with signed payloads, retries, and replay protection. It does not choose an event bus or a public endpoint. It hands you the dispatcher and a delivery store.

```typescript
import {
  FileWebhookDeliveryStore,
  FileWebhookEndpointStore,
  WebhookDispatcher,
  WebhookEndpointManager,
  transferWebhookEvent,
} from "@asctp/parabola/webhooks";

const endpointStore = new FileWebhookEndpointStore(
  ".parabola/webhook-endpoints",
);
const endpoints = new WebhookEndpointManager(endpointStore);
await endpoints.create({
  id: "orders",
  url: "https://example.com/parabola/events",
  secret: process.env.PARABOLA_WEBHOOK_SECRET!,
  events: ["transfer.minted", "transfer.failed"],
});

const dispatcher = new WebhookDispatcher({
  endpointStore,
  store: new FileWebhookDeliveryStore(".parabola/webhooks"),
});

await dispatcher.enqueue(transferWebhookEvent(record));
const result = await dispatcher.dispatchDue();
```

Each request is a `POST` with a JSON body. The `x-parabola-signature` header is `t=<unix-seconds>,v1=<hex>`, an HMAC-SHA256 over `<t>.<raw-body>`. Verify it before parsing the body:

```typescript
import {
  verifyWebhookSignature,
  WebhookReplayGuard,
} from "@asctp/parabola/webhooks";

const replay = new WebhookReplayGuard();

app.post("/parabola/events", async (request, response) => {
  const body = await readRawBody(request);
  const valid = verifyWebhookSignature({
    secret: process.env.PARABOLA_WEBHOOK_SECRET!,
    header: request.headers["x-parabola-signature"],
    body,
  });
  if (!valid) {
    return response.status(401).end();
  }

  const event = JSON.parse(body);
  if (!replay.accept(event.id)) {
    return response.status(409).end();
  }

  // handle event.type and event.data
  response.status(204).end();
});
```

Delivery is at least once. The dispatcher retries `408`, `429`, and `5xx` responses with exponential backoff, honors `Retry-After`, and stops after `maxAttempts`. Other `4xx` responses are terminal. Use `x-parabola-event-id` with `WebhookReplayGuard` to reject duplicates. `MemoryWebhookDeliveryStore` is for tests and single-process use. `FileWebhookDeliveryStore` is a single-host reference. `dispatchDue()` sends one batch of due deliveries, so call it on a timer or from your worker loop. `transferWebhookEvent()` maps a stored transfer record to `transfer.updated`, `transfer.minted`, `transfer.pending`, `transfer.recoverable`, or `transfer.failed`.

Endpoints are read from the store on each enqueue and delivery, so a change applies without rebuilding the dispatcher. `WebhookEndpointManager` validates URLs and secrets, rejects duplicate ids, and reports missing endpoints. `listFailed()` returns terminal deliveries, and `redeliver(id)` resets a failed delivery to pending with a fresh attempt budget:

```typescript
const failed = await dispatcher.listFailed();
if (failed[0]) {
  await dispatcher.redeliver(failed[0].id);
  await dispatcher.dispatchDue();
}
```

## Provider conformance

`@asctp/parabola/conformance` ships the checks a custom `ChainAdapter` or complete `SettlementDependencies` implementation must pass.

```typescript
import {
  assertChainAdapterConforms,
  assertSettlementDependenciesConform,
  probeChainAdapter,
} from "@asctp/parabola/conformance";
import { defaultSettlementDependencies } from "@asctp/parabola/providers";

assertChainAdapterConforms(myAdapter);
assertSettlementDependenciesConform(myDependencies);

const arcAdapter = defaultSettlementDependencies.chains.arc;
await probeChainAdapter(arcAdapter, {
  network: "testnet",
  amountRaw: 1_000_000n,
  recipient: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
  signer: arcSigner, // an ArcSigner funded on testnet
  message: "0x...",
  attestation: "0x...",
});
```

`assertChainAdapterConforms` is static and safe to run in unit tests. `probeChainAdapter` is an opt-in live check that calls the adapter's burn, mint, and recipient-check paths with the values you provide, so run it on testnet with funded keys. `@asctp/parabola/providers` adds `ChainAdapterRegistry`, which validates adapters, rejects duplicate chains, and builds the `chains` record the kernel consumes.

## Handling errors

The distinction that matters most in a service is between a transfer that is merely slow and one that has failed, because those are opposite instructions to your own caller.

| Error | Meaning | Usual response |
| --- | --- | --- |
| `AttestationNotReadyError` | Circle has not attested this burn yet. Retryable. | Retry later, typically `409` |
| `TransferError` with `code === "ATTESTATION_NOT_READY"` | Same condition, wrapped by `transfer()`. Retryable. | Retry later, typically `409` |
| `TransferError` without a code | A real failure after the burn, for example the mint step was rejected. | Stop, typically `502` |
| `SubmissionTimeoutError` | A transaction was broadcast but not confirmed in time. `hash` names it. | Reconcile against the chain |
| `IrisRequestError` | Circle's Iris API returned a non-OK response or the request failed. `status` holds the HTTP status when there was a response. | Treat as an upstream outage |

`transfer()` burns on the source chain before it polls for an attestation, so a rejection does not mean nothing happened. Any failure after the burn is thrown as a `TransferError` carrying `burnTxHash`, so you always keep the hash you need to recover:

```typescript
import { transfer, TransferError } from "@asctp/parabola";

try {
  await transfer(params);
} catch (err) {
  if (err instanceof TransferError) {
    if (err.code === "ATTESTATION_NOT_READY") {
      // funds left the source chain and Circle is still signing: retryable
    }
    await ledger.record({ burnTxHash: err.burnTxHash, attestationHash: err.attestationHash });
  }
  throw err;
}
```

A `404` from Iris is not an error. It means the burn has not been indexed yet, and `pollForAttestation` keeps polling through it. A persistent `5xx` is different: after five consecutive failures, polling stops with an `IrisRequestError` rather than running out the clock, so an Iris outage is distinguishable from a slow attestation instead of looking identical to one.

## Environment variables

Parabola's contract addresses, RPC URLs, and Iris endpoints are baked in for both mainnet and testnet, selected by the `network` parameter (see [Choosing a network](#choosing-a-network)). The examples read keys from your environment:

| Variable | Description |
| --- | --- |
| `ARC_PRIVATE_KEY` | EVM private key for an Arc account funded with USDC and gas. On testnet, fund via [faucet.circle.com](https://faucet.circle.com) |
| `STELLAR_SECRET_KEY` | Stellar secret key (`S...`) funded with USDC and XLM. On testnet, fund via [faucet.circle.com](https://faucet.circle.com) |
| `STELLAR_RPC_URL` | Optional Soroban RPC override, passed through as `options.stellarRpcUrl` |

Network configuration used internally:

| | Mainnet | Testnet |
| --- | --- | --- |
| Arc RPC | `https://rpc.mainnet.arc.io` (chain ID `5042`) | `https://rpc.testnet.arc.network` (chain ID `5042002`) |
| Stellar Soroban RPC | `https://mainnet.sorobanrpc.com` | `https://soroban-testnet.stellar.org` |
| Iris API | `https://iris-api.circle.com/v2/` | `https://iris-api-sandbox.circle.com/v2/` |

## Known limitations

- **`network` defaults to mainnet.** With `network` omitted, `transfer()` moves real USDC and spends real Arc gas. Pass `network: "testnet"` for development against faucet funds. See [Choosing a network](#choosing-a-network).
- **Raw `transfer()` and `completeMint()` do not dedupe.** A second `completeMint()` call for a burn that was already minted submits and is rejected on-chain, costing gas. Use the durable runtime with an idempotency key, or keep your own ledger keyed on the burn hash and network. See [Idempotency is yours to enforce at the raw SDK layer](#idempotency-is-yours-to-enforce-at-the-raw-sdk-layer).
- **The reference file stores are single-host.** `FileTransferStore` and `FileIndexerCursorStore` coordinate within one host. `createStoreServer()` with `RemoteTransferStore` and `RemoteIndexerCursorStore` gives multiple clients one store and lease authority, but the server remains a single coordination point rather than a distributed database.
- **The HTTP API and store server are operator surfaces, not public gateways.** They have optional bearer-token authentication and no per-route authorization, rate limiting, or TLS termination. Put them behind your own ingress and identity layer before exposing them beyond a trusted network.
- **Webhook delivery is at least once and single-host by default.** The dispatcher retries transient failures, but a receiver can see the same event more than once and must verify the signature and deduplicate on the event id. `FileWebhookEndpointStore` and `FileWebhookDeliveryStore` coordinate one host. There is no hosted endpoint management UI or automatic dead-letter worker; use `WebhookEndpointManager` and `redeliver()` from your own operator path.
- **The metrics and logger contracts are interfaces, not a backend.** `MemoryMetrics`, `MemoryLogger`, and `JsonLogger` are reference implementations. Connect your own Prometheus, OpenTelemetry, or log pipeline through the exported contracts.
- **The published tarball ships `dist/` only.** There is no `src/` in the package, so the documented surface is this README, `INTEGRATION.md`, `ARCHITECTURE.md`, and the type declarations. Questions those files do not answer have no second written source to fall back on.
- **Stellar inbound transfers require `CctpForwarder`.** This is a protocol requirement, not a Parabola choice: Circle's CCTP does not support minting directly to a Stellar address, so every transfer landing on Stellar routes through `mint_and_forward`.
- **No key custody.** Parabola never holds or transmits private keys. Completing a transfer's mint step on the destination chain requires a signer native to that chain (see `destinationSigner` above); Parabola cannot complete it for you without one.
- **Stellar recipients need a USDC trustline first.** USDC on Stellar is a classic Stellar asset under the hood; any account receiving it for the first time must submit its own `changeTrust` operation before `mint_and_forward` can pay out to it, same as any other Stellar USDC transfer. Parabola cannot establish this on a recipient's behalf (it has no signing relationship with an arbitrary third-party recipient). If the recipient hasn't received USDC on Stellar before, they need to set up the trustline themselves first.

## References

- [circlefin/stellar-cctp](https://github.com/circlefin/stellar-cctp): Circle's official Stellar CCTP contract source and reference TypeScript client (`examples/stellar.ts`, `examples/stellar-utils.ts`). This is the canonical source for contract argument order and hook-data byte layout; check it first before touching `src/chains/stellar.ts` or `src/utils/encoding.ts`'s Stellar-side functions.
- [CCTP developer docs](https://developers.circle.com/cctp): general CCTP V2 concepts, supported chains and domains, fees.
- [Arc docs](https://docs.arc.io): Arc network config and contract addresses.
- [COMPATIBILITY.md](COMPATIBILITY.md): the public API, versioning, supported runtimes, and deprecation policy.
- [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/adr](docs/adr): the kernel and provider boundary, the durable operation surface, the provider conformance decision, the webhook delivery and endpoint management decisions, and the remote store and lease server decision.

## Development

```bash
pnpm install
pnpm build            # tsup, emits ESM + CJS + type declarations to dist/
pnpm test             # vitest (mocked, no network access)
pnpm typecheck        # tsc --noEmit
pnpm verify:addresses # confirms every address in src/constants.ts is live on-chain (both networks)
pnpm smoke            # real end-to-end transfer against live testnet (needs funded keys); NETWORK=mainnet moves real funds
node dist/cli-entry.js --help # inspect the operator CLI after pnpm build
```

See [CONTRIBUTING.md's Testing Strategy](CONTRIBUTING.md#testing-strategy) for what each of these actually catches.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (issue templates, branch naming, commit convention, PR process), and the [Code of Conduct](CODE_OF_CONDUCT.md) that governs participation.

For security vulnerabilities, see [SECURITY.md](SECURITY.md) rather than opening a public issue.

If Parabola is useful to you, consider starring the repository.

## License

[MIT](LICENSE)
