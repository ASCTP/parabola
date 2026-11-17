import type { TransferResult } from "../types.js";
import type { TransferRecord } from "./contracts.js";

export function resultFromRecord(
  record: TransferRecord,
): TransferResult | undefined {
  if (record.result) {
    return record.result;
  }
  if (
    record.burnTxHash === undefined ||
    (record.phase !== "minted" && record.phase !== "pending")
  ) {
    return undefined;
  }
  return {
    status: record.phase === "minted" ? "success" : "pending",
    transferMode: record.transferMode ?? "standard",
    burnTxHash: record.burnTxHash,
    attestationHash: record.attestationHash ?? "",
    mintTxHash: record.mintTxHash ?? "",
    fee: record.fee ?? "0",
    durationMs: record.updatedAt - record.createdAt,
  };
}
