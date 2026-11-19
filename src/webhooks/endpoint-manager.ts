import type { WebhookEndpoint, WebhookEndpointStore } from "./contracts.js";
import {
  assertWebhookEndpoint,
  assertWebhookEndpoints,
} from "./endpoint-validation.js";
import {
  WebhookEndpointConflictError,
  WebhookEndpointNotFoundError,
} from "./errors.js";

export class WebhookEndpointManager {
  constructor(private readonly store: WebhookEndpointStore) {}

  async list(): Promise<WebhookEndpoint[]> {
    const endpoints = await this.store.list();
    assertWebhookEndpoints(endpoints);
    return endpoints;
  }

  async get(id: string): Promise<WebhookEndpoint | undefined> {
    const endpoint = await this.store.get(id);
    if (endpoint) {
      assertWebhookEndpoint(endpoint);
    }
    return endpoint;
  }

  async create(endpoint: WebhookEndpoint): Promise<WebhookEndpoint> {
    assertWebhookEndpoint(endpoint);
    if (!(await this.store.create(endpoint))) {
      throw new WebhookEndpointConflictError(endpoint.id);
    }
    return endpoint;
  }

  async update(endpoint: WebhookEndpoint): Promise<WebhookEndpoint> {
    assertWebhookEndpoint(endpoint);
    if (!(await this.store.get(endpoint.id))) {
      throw new WebhookEndpointNotFoundError(endpoint.id);
    }
    await this.store.put(endpoint);
    return endpoint;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.store.get(id))) {
      throw new WebhookEndpointNotFoundError(id);
    }
    await this.store.delete(id);
  }
}
