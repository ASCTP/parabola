import type { WebhookEndpoint, WebhookEndpointStore } from "./contracts.js";

function cloneEndpoint(endpoint: WebhookEndpoint): WebhookEndpoint {
  return {
    ...endpoint,
    events: endpoint.events ? [...endpoint.events] : undefined,
  };
}

export class MemoryWebhookEndpointStore implements WebhookEndpointStore {
  private readonly endpoints = new Map<string, WebhookEndpoint>();

  async get(id: string): Promise<WebhookEndpoint | undefined> {
    const endpoint = this.endpoints.get(id);
    return endpoint ? cloneEndpoint(endpoint) : undefined;
  }

  async list(): Promise<WebhookEndpoint[]> {
    return [...this.endpoints.values()]
      .map(cloneEndpoint)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async create(endpoint: WebhookEndpoint): Promise<boolean> {
    if (this.endpoints.has(endpoint.id)) {
      return false;
    }
    this.endpoints.set(endpoint.id, cloneEndpoint(endpoint));
    return true;
  }

  async put(endpoint: WebhookEndpoint): Promise<void> {
    this.endpoints.set(endpoint.id, cloneEndpoint(endpoint));
  }

  async delete(id: string): Promise<void> {
    this.endpoints.delete(id);
  }
}
