import { randomUUID } from "node:crypto";
import type { TransferResult } from "../types.js";
import type { TransferRecord, TransferStore } from "./contracts.js";
import {
  InvalidIdempotencyKeyError,
  TransferConflictError,
  TransferEvidenceError,
  TransferNotFoundError,
  TransferPersistenceError,
} from "./errors.js";
import { resultFromRecord } from "./record.js";

const DEFAULT_LEASE_MS = 60_000;

export interface TransferEvidence {
  burnTxHash?: string;
  attestationHash?: string;
  mintTxHash?: string;
}

export interface ReconcileTransferOptions {
  idempotencyKey: string;
  evidence: TransferEvidence;
  owner?: string;
  leaseMs?: number;
}

export interface ReconcileTransferOutcome {
  record: TransferRecord;
  result?: TransferResult;
  changed: boolean;
}

function normalizedHash(
  idempotencyKey: string,
  field: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new TransferEvidenceError(
      idempotencyKey,
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function normalizeEvidence(
  idempotencyKey: string,
  evidence: TransferEvidence,
): TransferEvidence {
  const burnTxHash = normalizedHash(
    idempotencyKey,
    "burnTxHash",
    evidence.burnTxHash,
  );
  const attestationHash = normalizedHash(
    idempotencyKey,
    "attestationHash",
    evidence.attestationHash,
  );
  const mintTxHash = normalizedHash(
    idempotencyKey,
    "mintTxHash",
    evidence.mintTxHash,
  );
  if (burnTxHash === undefined && mintTxHash === undefined) {
    throw new TransferEvidenceError(
      idempotencyKey,
      "a burn or mint transaction hash is required",
    );
  }
  return { burnTxHash, attestationHash, mintTxHash };
}

function assertMatches(
  idempotencyKey: string,
  field: string,
  current: string | undefined,
  observed: string | undefined,
): void {
  if (current !== undefined && observed !== undefined && current !== observed) {
    throw new TransferEvidenceError(
      idempotencyKey,
      `${field} conflicts with the stored transfer`,
    );
  }
}

function reconcileRecord(
  record: TransferRecord,
  evidence: TransferEvidence,
): boolean {
  if (record.phase === "failed") {
    throw new TransferEvidenceError(
      record.idempotencyKey,
      "failed transfers are terminal",
    );
  }

  assertMatches(
    record.idempotencyKey,
    "burnTxHash",
    record.burnTxHash,
    evidence.burnTxHash,
  );
  assertMatches(
    record.idempotencyKey,
    "attestationHash",
    record.attestationHash,
    evidence.attestationHash,
  );
  assertMatches(
    record.idempotencyKey,
    "mintTxHash",
    record.mintTxHash,
    evidence.mintTxHash,
  );

  if (evidence.mintTxHash !== undefined) {
    if (record.burnTxHash === undefined && evidence.burnTxHash === undefined) {
      throw new TransferEvidenceError(
        record.idempotencyKey,
        "mint evidence requires a burn transaction hash",
      );
    }

    let changed = false;
    if (record.burnTxHash === undefined && evidence.burnTxHash !== undefined) {
      record.burnTxHash = evidence.burnTxHash;
      changed = true;
    }
    if (
      record.attestationHash === undefined &&
      evidence.attestationHash !== undefined
    ) {
      record.attestationHash = evidence.attestationHash;
      changed = true;
    }
    if (record.mintTxHash !== evidence.mintTxHash) {
      record.mintTxHash = evidence.mintTxHash;
      changed = true;
    }
    if (record.phase !== "minted") {
      record.phase = "minted";
      changed = true;
    }
    if (record.error !== undefined) {
      delete record.error;
      changed = true;
    }

    if (changed) {
      record.updatedAt = Date.now();
      delete record.result;
      record.result = resultFromRecord(record);
    }
    return changed;
  }

  if (evidence.burnTxHash === undefined) {
    return false;
  }

  let changed = false;
  if (record.burnTxHash === undefined) {
    record.burnTxHash = evidence.burnTxHash;
    changed = true;
  }
  if (
    record.attestationHash === undefined &&
    evidence.attestationHash !== undefined
  ) {
    record.attestationHash = evidence.attestationHash;
    changed = true;
  }

  if (record.phase === "planned" || record.phase === "burning") {
    record.phase = "burned";
    delete record.error;
    changed = true;
  }

  if (changed) {
    record.updatedAt = Date.now();
    delete record.result;
    record.result = resultFromRecord(record);
  }
  return changed;
}

export async function reconcileTransfer(
  store: TransferStore,
  options: ReconcileTransferOptions,
): Promise<ReconcileTransferOutcome> {
  const idempotencyKey = options.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new InvalidIdempotencyKeyError();
  }
  const evidence = normalizeEvidence(idempotencyKey, options.evidence);
  const owner = options.owner ?? randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const claim = await store.claim(idempotencyKey, owner, leaseMs);
  if (claim.status === "busy") {
    const record = claim.record ?? (await store.get(idempotencyKey));
    if (!record) {
      throw new TransferNotFoundError(idempotencyKey);
    }
    throw new TransferConflictError("in_progress", record);
  }

  try {
    const record = claim.record;
    if (!record) {
      throw new TransferNotFoundError(idempotencyKey);
    }

    const changed = reconcileRecord(record, evidence);
    if (changed) {
      try {
        await store.put(record);
      } catch (err) {
        throw new TransferPersistenceError(
          "Failed to persist reconciled transfer state",
          record,
          record.result,
          { cause: err },
        );
      }
    }

    return { record, result: resultFromRecord(record), changed };
  } finally {
    await store.release(idempotencyKey, owner).catch(() => undefined);
  }
}
