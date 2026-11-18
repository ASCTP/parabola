import {
  ensureOk,
  RemoteStoreClient,
  type RemoteStoreOptions,
} from "../store-http.js";
import type {
  TransferClaim,
  TransferRecord,
  TransferStore,
} from "./contracts.js";

function pathFor(idempotencyKey: string): string {
  return `/transfers/${encodeURIComponent(idempotencyKey)}`;
}

export class RemoteTransferStore implements TransferStore {
  private readonly client: RemoteStoreClient;

  constructor(options: RemoteStoreOptions) {
    this.client = new RemoteStoreClient(options);
  }

  async get(
    idempotencyKey: string,
  ): Promise<TransferRecord | undefined> {
    const response = await this.client.request(
      "GET",
      pathFor(idempotencyKey),
    );
    if (response.status === 404) {
      return undefined;
    }
    const body = ensureOk(response) as { transfer: TransferRecord };
    return body.transfer;
  }

  async list(): Promise<TransferRecord[]> {
    const response = await this.client.request("GET", "/transfers");
    const body = ensureOk(response) as {
      transfers: TransferRecord[];
    };
    return body.transfers;
  }

  async create(record: TransferRecord): Promise<boolean> {
    const response = await this.client.request(
      "POST",
      "/transfers",
      record,
    );
    const body = ensureOk(response) as { created: boolean };
    return body.created;
  }

  async put(record: TransferRecord): Promise<void> {
    const response = await this.client.request(
      "PUT",
      pathFor(record.idempotencyKey),
      record,
    );
    ensureOk(response);
  }

  async delete(idempotencyKey: string): Promise<void> {
    const response = await this.client.request(
      "DELETE",
      pathFor(idempotencyKey),
    );
    ensureOk(response);
  }

  async claim(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<TransferClaim> {
    const response = await this.client.request(
      "POST",
      `${pathFor(idempotencyKey)}/claim`,
      { owner, leaseMs },
    );
    return ensureOk(response) as TransferClaim;
  }

  async renew(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean> {
    const response = await this.client.request(
      "POST",
      `${pathFor(idempotencyKey)}/renew`,
      { owner, leaseMs },
    );
    const body = ensureOk(response) as { renewed: boolean };
    return body.renewed;
  }

  async release(
    idempotencyKey: string,
    owner: string,
  ): Promise<void> {
    const response = await this.client.request(
      "POST",
      `${pathFor(idempotencyKey)}/release`,
      { owner },
    );
    ensureOk(response);
  }
}
