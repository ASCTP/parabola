import type { TransferRecord, TransferStore } from "./contracts.js";

function clone(record: TransferRecord): TransferRecord {
  return structuredClone(record);
}

export class MemoryTransferStore implements TransferStore {
  private readonly records = new Map<string, TransferRecord>();

  async get(idempotencyKey: string): Promise<TransferRecord | undefined> {
    const record = this.records.get(idempotencyKey);
    return record ? clone(record) : undefined;
  }

  async create(record: TransferRecord): Promise<boolean> {
    if (this.records.has(record.idempotencyKey)) {
      return false;
    }
    this.records.set(record.idempotencyKey, clone(record));
    return true;
  }

  async put(record: TransferRecord): Promise<void> {
    this.records.set(record.idempotencyKey, clone(record));
  }

  async delete(idempotencyKey: string): Promise<void> {
    this.records.delete(idempotencyKey);
  }
}
