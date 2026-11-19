import type { TransferRecord } from "../execution/contracts.js";

export type WebhookDeliveryStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed";

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events?: readonly string[];
  enabled?: boolean;
}

export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  createdAt: number;
  data: T;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  url: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  responseStatus?: number;
  lastError?: string;
  event: WebhookEvent;
}

export interface WebhookEndpointStore {
  get(id: string): Promise<WebhookEndpoint | undefined>;
  list(): Promise<WebhookEndpoint[]>;
  create(endpoint: WebhookEndpoint): Promise<boolean>;
  put(endpoint: WebhookEndpoint): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookDeliveryStore {
  get(id: string): Promise<WebhookDelivery | undefined>;
  list(): Promise<WebhookDelivery[]>;
  listDue(now: number, limit?: number): Promise<WebhookDelivery[]>;
  listFailed(limit?: number): Promise<WebhookDelivery[]>;
  create(delivery: WebhookDelivery): Promise<boolean>;
  put(delivery: WebhookDelivery): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookHttpResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
}

export interface WebhookHttpRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type WebhookFetch = (
  url: string,
  request: WebhookHttpRequest,
) => Promise<WebhookHttpResponse>;

export type TransferWebhookEventType =
  | "transfer.updated"
  | "transfer.minted"
  | "transfer.pending"
  | "transfer.recoverable"
  | "transfer.failed";

export interface TransferWebhookEvent extends WebhookEvent<TransferRecord> {
  type: TransferWebhookEventType;
}
