import { randomUUID } from "node:crypto";
import type { TransferRecord } from "../execution/contracts.js";
import type {
  TransferWebhookEvent,
  TransferWebhookEventType,
} from "./contracts.js";

export interface TransferWebhookEventOptions {
  id?: string;
  type?: TransferWebhookEventType;
  createdAt?: number;
}

function typeForPhase(
  phase: TransferRecord["phase"],
): TransferWebhookEventType {
  switch (phase) {
    case "minted":
      return "transfer.minted";
    case "pending":
      return "transfer.pending";
    case "recoverable":
      return "transfer.recoverable";
    case "failed":
      return "transfer.failed";
    default:
      return "transfer.updated";
  }
}

export function transferWebhookEvent(
  record: TransferRecord,
  options: TransferWebhookEventOptions = {},
): TransferWebhookEvent {
  const id = options.id ?? randomUUID();
  if (id === "") {
    throw new RangeError("Webhook event id must not be empty");
  }
  const createdAt = options.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt)) {
    throw new RangeError("Webhook event createdAt must be finite");
  }

  return {
    id,
    type: options.type ?? typeForPhase(record.phase),
    createdAt,
    data: {
      ...record,
      result: record.result ? { ...record.result } : undefined,
    },
  };
}
