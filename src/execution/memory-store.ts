import type {
  TransferClaim,
  TransferLease,
  TransferRecord,
  TransferStore,
} from "./contracts.js";

function clone(record: TransferRecord): TransferRecord {
  return structuredClone(record);
}

export class MemoryTransferStore implements TransferStore {
  private readonly records = new Map<string, TransferRecord>();
  private readonly leases = new Map<string, TransferLease>();

  async get(idempotencyKey: string): Promise<TransferRecord | undefined> {
    const record = this.records.get(idempotencyKey);
    return record ? clone(record) : undefined;
  }

  async list(): Promise<TransferRecord[]> {
    return [...this.records.values()]
      .map(clone)
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.idempotencyKey.localeCompare(b.idempotencyKey),
      );
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
    this.leases.delete(idempotencyKey);
  }

  async claim(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<TransferClaim> {
    const now = Date.now();
    const lease = this.leases.get(idempotencyKey);
    const record = await this.get(idempotencyKey);
    if (lease && lease.expiresAt > now && lease.owner !== owner) {
      return { status: "busy", record };
    }
    this.leases.set(idempotencyKey, {
      owner,
      expiresAt: now + leaseMs,
    });
    return record ? { status: "claimed", record } : { status: "claimed" };
  }

  async renew(
    idempotencyKey: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const lease = this.leases.get(idempotencyKey);
    if (!lease || lease.owner !== owner || lease.expiresAt <= now) {
      return false;
    }
    this.leases.set(idempotencyKey, {
      owner,
      expiresAt: now + leaseMs,
    });
    return true;
  }

  async release(idempotencyKey: string, owner: string): Promise<void> {
    const lease = this.leases.get(idempotencyKey);
    if (lease?.owner === owner) {
      this.leases.delete(idempotencyKey);
    }
  }
}
