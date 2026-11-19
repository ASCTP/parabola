import type { Hex } from "viem";
import {
  ensureOk,
  RemoteStoreClient,
  type RemoteStoreOptions,
} from "../store-http.js";
import type { IndexerCursor, IndexerCursorStore } from "./cursor.js";

interface SerializedCursor {
  stream: string;
  blockNumber: string;
  blockHash: Hex;
  updatedAt: number;
}

function pathFor(stream: string): string {
  return `/cursors/${encodeURIComponent(stream)}`;
}

export class RemoteIndexerCursorStore implements IndexerCursorStore {
  private readonly client: RemoteStoreClient;

  constructor(options: RemoteStoreOptions) {
    this.client = new RemoteStoreClient(options);
  }

  async get(stream: string): Promise<IndexerCursor | undefined> {
    const response = await this.client.request("GET", pathFor(stream));
    if (response.status === 404) {
      return undefined;
    }
    const body = ensureOk(response) as { cursor: SerializedCursor };
    return {
      stream: body.cursor.stream,
      blockNumber: BigInt(body.cursor.blockNumber),
      blockHash: body.cursor.blockHash,
      updatedAt: body.cursor.updatedAt,
    };
  }

  async put(cursor: IndexerCursor): Promise<void> {
    const response = await this.client.request(
      "PUT",
      pathFor(cursor.stream),
      cursor,
    );
    ensureOk(response);
  }

  async delete(stream: string): Promise<void> {
    const response = await this.client.request("DELETE", pathFor(stream));
    ensureOk(response);
  }
}
