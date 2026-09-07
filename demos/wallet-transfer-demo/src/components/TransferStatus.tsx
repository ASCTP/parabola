import type { ChainId, TransferResult } from "@asctp/parabola";
import { ARC_TESTNET } from "@asctp/parabola";
import { shortenTxHash, formatDurationMs } from "../lib/formatting.js";

function explorerUrl(chain: ChainId, txHash: string): string {
  if (chain === "arc") return `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
}

interface Props {
  result: TransferResult;
  from: ChainId;
  to: ChainId;
  onCompleteMint: () => void;
  completing: boolean;
  destinationWalletConnected: boolean;
}

export function TransferStatus({ result, from, to, onCompleteMint, completing, destinationWalletConnected }: Props) {
  return (
    <div className="transfer-status">
      <ol className="status-steps">
        <li className="status-step done">
          Burn on {from}
          {": "}
          <a href={explorerUrl(from, result.burnTxHash)} target="_blank" rel="noreferrer">
            {shortenTxHash(result.burnTxHash)}
          </a>
        </li>
        <li className={`status-step ${result.attestationHash ? "done" : "pending"}`}>
          Attestation{result.attestationHash ? `: ${shortenTxHash(result.attestationHash)}` : "..."}
        </li>
        <li className={`status-step ${result.status === "success" ? "done" : "pending"}`}>
          {result.status === "success" ? (
            <>
              Mint on {to}
              {": "}
              <a href={explorerUrl(to, result.mintTxHash)} target="_blank" rel="noreferrer">
                {shortenTxHash(result.mintTxHash)}
              </a>
            </>
          ) : (
            `Mint on ${to}: pending`
          )}
        </li>
      </ol>

      <p className="status-meta">
        {result.transferMode} transfer &middot; fee {result.fee} USDC &middot; {formatDurationMs(result.durationMs)}
      </p>

      {result.status === "pending" && (
        <div className="complete-mint">
          <p className="hint">
            No destination signer was attached, so the transfer stopped after the burn and
            attestation. This is the recovery path: call <code>completeMint()</code> with the
            stored <code>burnTxHash</code> whenever the destination wallet is available.
          </p>
          <button onClick={onCompleteMint} disabled={completing || !destinationWalletConnected}>
            {completing
              ? "Completing..."
              : destinationWalletConnected
                ? "Complete mint"
                : `Connect ${to} wallet to complete`}
          </button>
        </div>
      )}
    </div>
  );
}
