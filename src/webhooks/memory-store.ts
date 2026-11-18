import type {
  WebhookDelivery,
  WebhookDeliveryStore,
  WebhookEvent,
} from "./contracts.js";

function cloneEvent(event: WebhookEvent): WebhookEvent {
  return { ...event, data: structuredClone(event.data) };
}

function cloneDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return { ...delivery, event: cloneEvent(delivery.event) };
}

function sortDeliveries(
  a: WebhookDelivery,
  b: WebhookDelivery,
): number {
  return (
    a.nextAttemptAt - b.nextAttemptAt ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

function sortFailed(
  a: WebhookDelivery,
  b: WebhookDelivery,
): number {
  return a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
}

export class MemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries = new Map<string, WebhookDelivery>();

  async get(id: string): Promise<WebhookDelivery | undefined> {
    const delivery = this.deliveries.get(id);
    return delivery ? cloneDelivery(delivery) : undefined;
  }

  async list(): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .map(cloneDelivery)
      .sort(sortDeliveries);
  }

  async listDue(
    now: number,
    limit?: number,
  ): Promise<WebhookDelivery[]> {
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 0)
    ) {
      throw new RangeError("limit must be a non-negative integer");
    }
    const due = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          delivery.status === "pending" &&
          delivery.nextAttemptAt <= now,
      )
      .map(cloneDelivery)
      .sort(sortDeliveries);
    return limit === undefined ? due : due.slice(0, limit);
  }

  async listFailed(limit?: number): Promise<WebhookDelivery[]> {
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 0)
    ) {
      throw new RangeError("limit must be a non-negative integer");
    }
    const failed = [...this.deliveries.values()]
      .filter((delivery) => delivery.status === "failed")
      .map(cloneDelivery)
      .sort(sortFailed);
    return limit === undefined ? failed : failed.slice(0, limit);
  }

  async create(delivery: WebhookDelivery): Promise<boolean> {
    if (this.deliveries.has(delivery.id)) {
      return false;
    }
    this.deliveries.set(delivery.id, cloneDelivery(delivery));
    return true;
  }

  async put(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, cloneDelivery(delivery));
  }

  async delete(id: string): Promise<void> {
    this.deliveries.delete(id);
  }
}
