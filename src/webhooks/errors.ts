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
