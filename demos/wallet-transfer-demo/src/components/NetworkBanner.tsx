import type { Network } from "@asctp/parabola";

interface Props {
  network: Network;
  onChange: (network: Network) => void;
  disabled: boolean;
}

/**
 * Prominent, always-visible indicator of which network the demo is pointed at. On mainnet it
 * turns red and spells out that transfers move real USDC, so there is no way to trigger a
 * real-money transfer while believing you are on testnet. Switching is blocked mid-transfer
 * (disabled) and disconnects wallets in the parent, since a connected Arc signer is bound to
 * one chain.
 */
export function NetworkBanner({ network, onChange, disabled }: Props) {
  const isMainnet = network === "mainnet";
  return (
    <div className={`network-banner ${isMainnet ? "mainnet" : "testnet"}`}>
      <div className="network-banner-label">
        <span className="network-dot" aria-hidden="true" />
        <strong>{isMainnet ? "MAINNET" : "TESTNET"}</strong>
        <span>
          {isMainnet
            ? "Transfers move real USDC and spend real Arc gas."
            : "Safe to test. Uses faucet funds, no real money moves."}
        </span>
      </div>
      <label className="network-toggle">
        <span>Network</span>
        <select
          value={network}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as Network)}
        >
          <option value="testnet">Testnet</option>
          <option value="mainnet">Mainnet (real funds)</option>
        </select>
      </label>
    </div>
  );
}
