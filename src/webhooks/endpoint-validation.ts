import type { WebhookEndpoint } from "./contracts.js";
import { WebhookConfigurationError } from "./errors.js";

export function assertWebhookEndpoint(endpoint: WebhookEndpoint): void {
  if (endpoint.id.trim() === "") {
    throw new WebhookConfigurationError(
      "Webhook endpoint id must not be empty",
    );
  }
  if (endpoint.secret === "") {
    throw new WebhookConfigurationError(
      "Webhook endpoint secret must not be empty",
      endpoint.id,
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new WebhookConfigurationError(
      "Webhook endpoint url must be a valid URL",
      endpoint.id,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebhookConfigurationError(
      "Webhook endpoint url must use http or https",
      endpoint.id,
    );
  }
}

export function assertWebhookEndpoints(
  endpoints: readonly WebhookEndpoint[],
): void {
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    assertWebhookEndpoint(endpoint);
    if (ids.has(endpoint.id)) {
      throw new WebhookConfigurationError(
        `Webhook endpoint ${endpoint.id} is registered more than once`,
        endpoint.id,
      );
    }
    ids.add(endpoint.id);
  }
}
