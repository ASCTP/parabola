import {
  arcMainnetChain,
  arcTestnetChain,
  ARC_MAINNET,
  ARC_TESTNET,
  STELLAR_MAINNET,
  STELLAR_TESTNET,
  type Network,
} from "@asctp/parabola";

export type { Network };

// The demo's initial network. Deployed builds (for example the mainnet submission) set
// VITE_NETWORK=mainnet; anything else, including an unset value during local development,
// falls back to testnet so a fresh checkout never moves real funds by default. The user can
// still switch at runtime from the UI before connecting a wallet.
export const DEFAULT_NETWORK: Network =
  import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";

export function arcChainFor(network: Network) {
  return network === "mainnet" ? arcMainnetChain : arcTestnetChain;
}

export function arcNetworkConfig(network: Network) {
  return network === "mainnet" ? ARC_MAINNET : ARC_TESTNET;
}

export function stellarNetworkPassphrase(network: Network): string {
  return network === "mainnet"
    ? STELLAR_MAINNET.networkPassphrase
    : STELLAR_TESTNET.networkPassphrase;
}
