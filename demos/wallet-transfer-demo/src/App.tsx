import { useState } from "react";
import type { TransferParams, CompleteMintParams, Signer } from "@asctp/parabola";
import { useArcWallet } from "./hooks/useArcWallet.js";
import { useStellarWallet } from "./hooks/useStellarWallet.js";
import { useTransfer } from "./hooks/useTransfer.js";
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
  const arcWallet = useArcWallet();
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

  function signerFor(chain: "arc" | "stellar"): Signer | null {
    return chain === "arc" ? arcWallet.signer : stellarWallet.signer;
  }

  async function handleSubmit() {
    const signer = signerFor(form.from);
    if (!signer) return;

    const destinationSigner = form.useDestinationSigner ? signerFor(form.to) : undefined;

    const params: TransferParams = {
      from: form.from,
      to: form.to,
      amount: form.amount,
      recipient: form.recipient,
      speed: form.speed,
      signer,
      options: destinationSigner ? { destinationSigner } : undefined,
    };

    await submit(params);
  }

  async function handleCompleteMint() {
    if (!result) return;
    const destinationSigner = signerFor(form.to);
    if (!destinationSigner) return;

    const params: CompleteMintParams = {
      from: form.from,
      to: form.to,
      burnTxHash: result.burnTxHash,
      signer: destinationSigner,
    };

    await finishPending(params);
  }

  async function handleRecoverMint() {
    if (!recoverableBurnTxHash) return;
    const destinationSigner = signerFor(form.to);
    if (!destinationSigner) return;

    const params: CompleteMintParams = {
      from: form.from,
      to: form.to,
      burnTxHash: recoverableBurnTxHash,
      signer: destinationSigner,
    };

    await finishPending(params);
  }

  return (
    <div className="app">
      <header>
        <h1>Parabola wallet transfer demo</h1>
        <p className="subtitle">
          Connect your own wallets and trigger a real, non-custodial USDC transfer between Arc
          and Stellar testnet. See{" "}
          <a href="https://github.com/ASCTP/parabola/blob/main/INTEGRATION.md" target="_blank" rel="noreferrer">
            INTEGRATION.md
          </a>{" "}
          for the patterns this app illustrates.
        </p>
      </header>

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
          destinationWalletConnected={signerFor(form.to) !== null}
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
            destinationWalletConnected={signerFor(form.to) !== null}
          />
        </section>
      )}
    </div>
  );
}
