import type { WebhookDeliveryStatus } from "./contracts.js";

export class WebhookConfigurationError extends Error {
  readonly endpointId?: string;

  constructor(message: string, endpointId?: string) {
    super(message);
    this.name = new.target.name;
    this.endpointId = endpointId;
  }
}

export class InvalidWebhookEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WebhookEndpointNotFoundError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string) {
    super(`Webhook endpoint ${endpointId} was not found`);
    this.name = new.target.name;
    this.endpointId = endpointId;
  }
}

export class WebhookEndpointConflictError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string) {
    super(`Webhook endpoint ${endpointId} already exists`);
    this.name = new.target.name;
    this.endpointId = endpointId;
  }
}

export class WebhookDeliveryNotFoundError extends Error {
  readonly deliveryId: string;

  constructor(deliveryId: string) {
    super(`Webhook delivery ${deliveryId} was not found`);
    this.name = new.target.name;
    this.deliveryId = deliveryId;
  }
}

export class WebhookDeliveryStateError extends Error {
  readonly deliveryId: string;
  readonly status: WebhookDeliveryStatus;

  constructor(deliveryId: string, status: WebhookDeliveryStatus) {
    super(`Webhook delivery ${deliveryId} is ${status}, not failed`);
    this.name = new.target.name;
    this.deliveryId = deliveryId;
    this.status = status;
  }
}
