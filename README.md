# Parabola

Parabola is a developer platform for the Arc&harr;Stellar USDC corridor. Today that means an SDK;
a local dev CLI, gas abstraction, and transfer observability are the direction it's headed as the
corridor sees real usage. That's a lens on where this goes, not a committed timeline.

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

## Arc to Stellar

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { transfer, arcTestnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as `0x${string}`);
const arcSigner: ArcSigner = {
  walletClient: createWalletClient({
    account: arcAccount,
    chain: arcTestnetChain,
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
import { transfer, arcTestnetChain, type ArcSigner, type StellarSigner } from "@asctp/parabola";

const stellarKeypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);
const stellarSigner: StellarSigner = {
  publicKey: stellarKeypair.publicKey(),
  keypair: stellarKeypair,
};

const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY as `0x${string}`);
const destinationSigner: ArcSigner = {
  walletClient: createWalletClient({
    account: arcAccount,
    chain: arcTestnetChain,
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
- Converts between Stellar USDC's 7-decimal precision and Arc USDC's 6-decimal precision, so you always work in human-readable amounts like `"10.50"`.
- Picks Standard or Fast transfer based on `speed`, quotes the Fast fee from Circle's fees endpoint first, and falls back to Standard automatically if the quoted fee exceeds `maxFee`.

### Completing the mint: `destinationSigner` and `completeMint`

`receiveMessage` and `mint_and_forward` are permissionless CCTP calls, but submitting them still costs gas natively on the destination chain, and Parabola never holds keys on your behalf. Pass `options.destinationSigner` with a signer for the *destination* chain to have Parabola submit that step automatically as part of the single `transfer()` call.

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

## Checking a Stellar recipient before you transfer

A Stellar account doesn't exist on-ledger until it's funded with the minimum XLM reserve, and it can't hold USDC until it also has a USDC trustline. When the destination of a transfer is Stellar, `transfer()` checks both automatically before submitting anything on the source chain, and throws a clear error up front if the recipient isn't ready instead of letting the burn go through and only failing later at the mint step, with the USDC then stuck at the `CctpForwarder` contract.

You can also run this check yourself ahead of time, for example to validate a recipient address in a form before a user submits a transfer:

```typescript
import { checkStellarRecipientReady } from "@asctp/parabola";

const status = await checkStellarRecipientReady("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI");
console.log(status);
// { exists: true, hasTrustline: true, ready: true }
```

## Environment variables

Parabola's contract addresses, RPC URLs, and Iris endpoints are baked in (testnet only, see Known Limitations). The examples read these from your environment:

| Variable | Description |
| --- | --- |
| `ARC_PRIVATE_KEY` | EVM private key for an Arc testnet account, funded via [faucet.circle.com](https://faucet.circle.com) |
| `STELLAR_SECRET_KEY` | Stellar secret key (`S...`) for a Stellar testnet account, funded via [faucet.circle.com](https://faucet.circle.com) |

Network configuration used internally:

- Arc testnet RPC: `https://rpc.testnet.arc.network` (chain ID `5042002`)
- Stellar Soroban testnet RPC: `https://soroban-testnet.stellar.org`
- Iris sandbox API: `https://iris-api-sandbox.circle.com/v2/`

## Known limitations

- **Testnet only.** Arc is currently in public testnet ahead of its 2026 mainnet launch, so Parabola only ships Arc testnet contract addresses. Mainnet support lands once Arc mainnet and its CCTP deployment are public.
- **Stellar inbound transfers require `CctpForwarder`.** This is a protocol requirement, not a Parabola choice: Circle's CCTP does not support minting directly to a Stellar address, so every transfer landing on Stellar routes through `mint_and_forward`.
- **No key custody.** Parabola never holds or transmits private keys. Completing a transfer's mint step on the destination chain requires a signer native to that chain (see `destinationSigner` above); Parabola cannot complete it for you without one.
- **Stellar recipients need a USDC trustline first.** USDC on Stellar is a classic Stellar asset under the hood; any account receiving it for the first time must submit its own `changeTrust` operation before `mint_and_forward` can pay out to it, same as any other Stellar USDC transfer. Parabola cannot establish this on a recipient's behalf (it has no signing relationship with an arbitrary third-party recipient). If the recipient hasn't received USDC on Stellar before, they need to set up the trustline themselves first.

## References

- [circlefin/stellar-cctp](https://github.com/circlefin/stellar-cctp): Circle's official Stellar CCTP contract source and reference TypeScript client (`examples/stellar.ts`, `examples/stellar-utils.ts`). This is the canonical source for contract argument order and hook-data byte layout; check it first before touching `src/chains/stellar.ts` or `src/utils/encoding.ts`'s Stellar-side functions.
- [CCTP developer docs](https://developers.circle.com/cctp): general CCTP V2 concepts, supported chains and domains, fees.
- [Arc docs](https://docs.arc.io): Arc network config and contract addresses.

## Development

```bash
pnpm install
pnpm build            # tsup, emits ESM + CJS + type declarations to dist/
pnpm test             # vitest (mocked, no network access)
pnpm typecheck        # tsc --noEmit
pnpm verify:addresses # confirms every address in src/constants.ts is live on-chain
pnpm smoke            # real end-to-end transfer against live testnet (needs funded keys)
```

See [CONTRIBUTING.md's Testing Strategy](CONTRIBUTING.md#testing-strategy) for what each of these actually catches.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (issue templates, branch naming, commit convention, PR process), and the [Code of Conduct](CODE_OF_CONDUCT.md) that governs participation.

For security vulnerabilities, see [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[MIT](LICENSE)
