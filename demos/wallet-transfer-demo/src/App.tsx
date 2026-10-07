import { useState } from "react";
import type { TransferParams, CompleteMintParams, Network } from "@asctp/parabola";
import { DEFAULT_NETWORK } from "./lib/network.js";
import { useArcWallet } from "./hooks/useArcWallet.js";
import { useStellarWallet } from "./hooks/useStellarWallet.js";
import { useTransfer } from "./hooks/useTransfer.js";
import { NetworkBanner } from "./components/NetworkBanner.js";
import { ArcWalletConnect } from "./components/ArcWalletConnect.js";
import { StellarWalletConnect } from "./components/StellarWalletConnect.js";
import { TransferForm, type TransferFormState } from "./components/TransferForm.js";
import { FeeEstimate } from "./components/FeeEstimate.js";
import { TransferStatus } from "./components/TransferStatus.js";
import { ErrorBanner } from "./components/ErrorBanner.js";

const initialForm: TransferFormState = {
  from: "arc",
  to: "stellar",
  amount: "",
  recipient: "",
  speed: "standard",
  useDestinationSigner: true,
};

export function App() {
  const [network, setNetwork] = useState<Network>(DEFAULT_NETWORK);
  const arcWallet = useArcWallet(network);
  const stellarWallet = useStellarWallet();
  const {
    status,
    result,
    error,
    recoverableBurnTxHash,
    submissionUncertain,
    submit,
    finishPending,
    feeEstimate,
    estimating,
    estimate,
    reset,
  } = useTransfer();

  const [form, setForm] = useState<TransferFormState>(initialForm);

  // An Arc signer is a viem WalletClient bound to one chain, so switching networks while a
  // wallet is connected would leave a signer pointed at the wrong chain. Drop both and clear
  // any in-flight result so the user reconnects on the network they just chose.
  function handleNetworkChange(next: Network) {
    if (next === network) return;
    arcWallet.disconnect();
    stellarWallet.disconnect();
    reset();
    setNetwork(next);
  }

  // form.from and form.to are runtime values, so the direction has to be restated as a
  // literal pair for the compiler to select the signers the SDK requires: `signer` native to
  // the source chain, and options.destinationSigner native to the destination chain. The form
  // only ever holds the two supported directions, which flipDirection() preserves.
  function burnParams(): TransferParams | null {
    const shared = {
      amount: form.amount,
      recipient: form.recipient,
      speed: form.speed,
      network,
    };

    if (form.from === "arc") {
      const signer = arcWallet.signer;
      if (!signer) return null;
      const destinationSigner = form.useDestinationSigner ? stellarWallet.signer : null;
      return {
        ...shared,
        from: "arc",
        to: "stellar",
        signer,
        options: destinationSigner ? { destinationSigner } : undefined,
      };
    }

    const signer = stellarWallet.signer;
    if (!signer) return null;
    const destinationSigner = form.useDestinationSigner ? arcWallet.signer : null;
    return {
      ...shared,
      from: "stellar",
      to: "arc",
      signer,
      options: destinationSigner ? { destinationSigner } : undefined,
    };
  }

  // The mint runs on form.to, so that is the chain whose signer must be supplied.
  function mintParams(burnTxHash: string): CompleteMintParams | null {
    if (form.to === "arc") {
      const signer = arcWallet.signer;
      return signer ? { from: "stellar", to: "arc", burnTxHash, signer, network } : null;
    }
    const signer = stellarWallet.signer;
    return signer ? { from: "arc", to: "stellar", burnTxHash, signer, network } : null;
  }

  // The mint runs on form.to, so a connected wallet on that chain is what makes the
  // completion step possible.
  function destinationWalletConnected(): boolean {
    return form.to === "arc" ? arcWallet.signer !== null : stellarWallet.signer !== null;
  }

  async function handleSubmit() {
    const params = burnParams();
    if (!params) return;

    await submit(params);
  }

  async function handleCompleteMint() {
    if (!result) return;
    const params = mintParams(result.burnTxHash);
    if (!params) return;

    await finishPending(params);
  }

  async function handleRecoverMint() {
    if (!recoverableBurnTxHash) return;
    const params = mintParams(recoverableBurnTxHash);
    if (!params) return;

    await finishPending(params);
  }

  return (
    <div className="app">
      <header>
        <h1>Parabola wallet transfer demo</h1>
        <p className="subtitle">
          Connect your own wallets and trigger a real, non-custodial USDC transfer between Arc
          and Stellar. See{" "}
          <a href="https://github.com/ASCTP/parabola/blob/main/INTEGRATION.md" target="_blank" rel="noreferrer">
            INTEGRATION.md
          </a>{" "}
          for the patterns this app illustrates.
        </p>
      </header>

      <NetworkBanner
        network={network}
        onChange={handleNetworkChange}
        disabled={status === "submitting"}
      />

      <section className="wallets">
        <ArcWalletConnect wallet={arcWallet} />
        <StellarWalletConnect wallet={stellarWallet} />
      </section>

      <section>
        <TransferForm
          value={form}
          onChange={setForm}
          arcWallet={arcWallet}
          stellarWallet={stellarWallet}
          onSubmit={handleSubmit}
          submitting={status === "submitting"}
        />
        <FeeEstimate
          from={form.from}
          to={form.to}
          amount={form.amount}
          speed={form.speed}
          network={network}
          feeEstimate={feeEstimate}
          estimating={estimating}
          onEstimate={estimate}
        />
      </section>

      {error && (
        <ErrorBanner
          message={error}
          recoverableBurnTxHash={recoverableBurnTxHash}
          submissionUncertain={submissionUncertain}
          destinationWalletConnected={destinationWalletConnected()}
          onRecover={handleRecoverMint}
          recovering={status === "submitting"}
          onDismiss={reset}
        />
      )}

      {result && (
        <section>
          <TransferStatus
            result={result}
            from={form.from}
            to={form.to}
            onCompleteMint={handleCompleteMint}
            completing={status === "submitting"}
            destinationWalletConnected={destinationWalletConnected()}
          />
        </section>
      )}
    </div>
  );
}
