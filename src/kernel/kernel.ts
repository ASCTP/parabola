import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  FINALITY_THRESHOLD_FAST,
  FINALITY_THRESHOLD_STANDARD,
} from "../constants.js";
import {
  AttestationNotReadyError,
  SubmissionTimeoutError,
  TransferError,
} from "../errors.js";
import { TransferProgressError } from "./errors.js";
import type {
  CompleteMintParams,
  CompleteMintResult,
  ResolveBurnParams,
  ResolvedBurn,
  TransferMode,
  TransferParams,
  TransferResult,
} from "../types.js";
import { decimalsForChain, fromRawAmount, toRawAmount } from "../utils/amount.js";
import { parseUsdcAmount } from "../utils/encoding.js";
import { decodeCctpMessage } from "../utils/message.js";
import type {
  SettlementDependencies,
  SettlementKernel,
  TransferProgress,
  TransferProgressHandler,
  TransferRunOptions,
} from "./contracts.js";
import { transition, type TransferPhase } from "./state.js";

const FAST_ESTIMATED_DURATION_SECONDS = 15;

function progressReporter(handler?: TransferProgressHandler) {
  return async (progress: TransferProgress): Promise<void> => {
    if (!handler) {
      return;
    }
    try {
      await handler(progress);
    } catch (err) {
      throw new TransferProgressError(err);
    }
  };
}

export function createSettlementKernel(
  deps: SettlementDependencies,
): SettlementKernel {
  return {
    async transfer(
      params: TransferParams,
      runOptions?: TransferRunOptions,
    ): Promise<TransferResult> {
      const start = Date.now();
      const report = progressReporter(runOptions?.onProgress);
      const options = params.options ?? {};
      const network = params.network ?? "mainnet";
      const stellarRpcUrl = options.stellarRpcUrl;
      const arcRpcUrl = options.arcRpcUrl;
      const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
      const pollTimeout = options.pollTimeout ?? DEFAULT_POLL_TIMEOUT_MS;

      let transferMode: TransferMode = params.speed;
      let feeRaw = 0n;

      if (transferMode === "fast") {
        if (
          options.maxWait !== undefined &&
          FAST_ESTIMATED_DURATION_SECONDS > options.maxWait
        ) {
          transferMode = "standard";
        } else {
          const feeBps = await deps.fees.fastTransferFeeBps({
            from: params.from,
            to: params.to,
            network,
          });
          const amountRawSource = toRawAmount(params.amount, params.from);
          feeRaw = (amountRawSource * BigInt(feeBps)) / 10_000n;
          if (options.maxFee !== undefined) {
            const maxFeeRaw = parseUsdcAmount(
              options.maxFee,
              decimalsForChain(params.from),
            );
            if (feeRaw > maxFeeRaw) {
              transferMode = "standard";
              feeRaw = 0n;
            }
          }
        }
      }

      const minFinalityThreshold =
        transferMode === "fast"
          ? FINALITY_THRESHOLD_FAST
          : FINALITY_THRESHOLD_STANDARD;
      const amountRaw = toRawAmount(params.amount, params.from);
      const maxFeeRaw =
        transferMode === "fast" && options.maxFee !== undefined
          ? parseUsdcAmount(options.maxFee, decimalsForChain(params.from))
          : feeRaw;
      const fee =
        transferMode === "fast" ? fromRawAmount(feeRaw, params.from) : "0";

      const sourceAdapter = deps.chains[params.from];
      const destinationAdapter = deps.chains[params.to];

      let phase: TransferPhase = "planned";

      try {
        await destinationAdapter.assertCanReceive?.({
          recipient: params.recipient,
          network,
          rpcUrl: params.to === "stellar" ? stellarRpcUrl : arcRpcUrl,
        });
      } catch (err) {
        transition(phase, { type: "BURN_FAILED" });
        throw err;
      }

      phase = transition(phase, { type: "BURN_STARTED" });
      await report({ phase, transferMode, fee });
      let burnTxHash: string;
      try {
        const burn = await sourceAdapter.burn({
          from: params.from,
          to: params.to,
          network,
          amountRaw,
          recipient: params.recipient,
          maxFeeRaw,
          minFinalityThreshold,
          signer: params.signer,
          rpcUrl: params.from === "arc" ? arcRpcUrl : stellarRpcUrl,
        });
        burnTxHash = burn.transactionHash;
      } catch (err) {
        transition(phase, { type: "BURN_FAILED" });
        if (err instanceof SubmissionTimeoutError) {
          throw new TransferError(err.message, err.hash);
        }
        throw err;
      }
      phase = transition(phase, { type: "BURN_CONFIRMED" });
      await report({ phase, burnTxHash, transferMode, fee });

      let attestationHash: string | undefined;
      let mintTxHash = "";
      let status: TransferResult["status"] = "pending";

      try {
        phase = transition(phase, { type: "ATTESTATION_STARTED" });
        const attestation = await deps.attestations.poll({
          source: params.from,
          transactionHash: burnTxHash,
          network,
          pollInterval,
          pollTimeout,
        });
        phase = transition(phase, { type: "ATTESTATION_READY" });
        attestationHash = attestation.attestation ?? undefined;
        await report({
          phase,
          burnTxHash,
          attestationHash,
          transferMode,
          fee,
        });

        if (
          options.destinationSigner &&
          attestation.message &&
          attestation.attestation
        ) {
          phase = transition(phase, { type: "MINT_STARTED" });
          await report({
            phase,
            burnTxHash,
            attestationHash,
            transferMode,
            fee,
          });
          const mint = await destinationAdapter.mint({
            from: params.from,
            to: params.to,
            network,
            message: attestation.message as `0x${string}`,
            attestation: attestation.attestation as `0x${string}`,
            signer: options.destinationSigner,
            rpcUrl: params.to === "arc" ? arcRpcUrl : stellarRpcUrl,
          });
          mintTxHash = mint.transactionHash;
          phase = transition(phase, { type: "MINT_CONFIRMED" });
          await report({
            phase,
            burnTxHash,
            attestationHash,
            mintTxHash,
            transferMode,
            fee,
          });
          status = "success";
        } else {
          phase = transition(phase, { type: "DEFERRED" });
          await report({
            phase,
            burnTxHash,
            attestationHash,
            transferMode,
            fee,
          });
        }
      } catch (err) {
        if (err instanceof TransferProgressError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err instanceof AttestationNotReadyError
            ? "ATTESTATION_NOT_READY"
            : undefined;
        transition(phase, { type: "RECOVERY_REQUIRED" });
        throw new TransferError(message, burnTxHash, attestationHash, code);
      }

      return {
        status,
        transferMode,
        burnTxHash,
        attestationHash: attestationHash ?? "",
        mintTxHash,
        fee,
        durationMs: Date.now() - start,
      };
    },

    async completeMint(
      params: CompleteMintParams,
      runOptions?: TransferRunOptions,
    ): Promise<CompleteMintResult> {
      const report = progressReporter(runOptions?.onProgress);
      const network = params.network ?? "mainnet";
      const options = params.options ?? {};
      const pollInterval =
        options.pollInterval ?? params.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
      const pollTimeout =
        options.pollTimeout ?? params.pollTimeout ?? DEFAULT_POLL_TIMEOUT_MS;
      const stellarRpcUrl = options.stellarRpcUrl ?? params.stellarRpcUrl;
      const arcRpcUrl = options.arcRpcUrl ?? params.arcRpcUrl;

      let phase: TransferPhase = "burned";

      try {
        phase = transition(phase, { type: "ATTESTATION_STARTED" });
        await report({ phase, burnTxHash: params.burnTxHash });
        const attestation = await deps.attestations.poll({
          source: params.from,
          transactionHash: params.burnTxHash,
          network,
          pollInterval,
          pollTimeout,
        });
        phase = transition(phase, { type: "ATTESTATION_READY" });

        if (!attestation.message || !attestation.attestation) {
          throw new AttestationNotReadyError(
            `Iris returned no attestation for burn ${params.burnTxHash}`,
            params.burnTxHash,
          );
        }
        await report({
          phase,
          burnTxHash: params.burnTxHash,
          attestationHash: attestation.attestation,
        });

        if (params.to === "stellar") {
          const { forwardRecipient } = decodeCctpMessage(attestation.message);
          if (!forwardRecipient) {
            throw new Error(
              `Burn ${params.burnTxHash} carries no readable Stellar forward recipient, so the account this mint would pay cannot be determined. Refusing to submit a mint to an unknown destination.`,
            );
          }
          await deps.chains.stellar.assertCanReceive?.({
            recipient: forwardRecipient,
            network,
            rpcUrl: stellarRpcUrl,
          });
        }

        phase = transition(phase, { type: "MINT_STARTED" });
        await report({
          phase,
          burnTxHash: params.burnTxHash,
          attestationHash: attestation.attestation,
        });
        const mint = await deps.chains[params.to].mint({
          from: params.from,
          to: params.to,
          network,
          message: attestation.message as `0x${string}`,
          attestation: attestation.attestation as `0x${string}`,
          signer: params.signer,
          rpcUrl: params.to === "arc" ? arcRpcUrl : stellarRpcUrl,
        });
        phase = transition(phase, { type: "MINT_CONFIRMED" });
        await report({
          phase,
          burnTxHash: params.burnTxHash,
          attestationHash: attestation.attestation,
          mintTxHash: mint.transactionHash,
        });

        return {
          mintTxHash: mint.transactionHash,
          attestationHash: attestation.attestation,
        };
      } catch (err) {
        if (err instanceof TransferProgressError) {
          throw err;
        }
        transition(phase, { type: "RECOVERY_REQUIRED" });
        throw err;
      }
    },

    async resolveBurn(params: ResolveBurnParams): Promise<ResolvedBurn> {
      const network = params.network ?? "mainnet";
      const attestation = await deps.attestations.read({
        source: params.from,
        transactionHash: params.burnTxHash,
        network,
      });

      if (!attestation.message) {
        throw new AttestationNotReadyError(
          `Iris has indexed burn ${params.burnTxHash} but returned no message for it`,
          params.burnTxHash,
        );
      }

      return {
        ...decodeCctpMessage(attestation.message),
        attestation: attestation.attestation,
      };
    },
  };
}
