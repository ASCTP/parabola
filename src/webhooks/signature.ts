import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_REPLAY_TTL_MS = 300_000;
const DEFAULT_REPLAY_MAX_ENTRIES = 10_000;

export interface WebhookSignatureOptions {
  secret: string;
  header: string | null | undefined;
  body: string;
  toleranceSeconds?: number;
  now?: number;
}

export interface WebhookReplayGuardOptions {
  ttlMs?: number;
  maxEntries?: number;
}

function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | undefined {
  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return undefined;
      }
      timestamp = parsed;
    } else if (key === "v1") {
      signature = value;
    }
  }

  if (timestamp === undefined || signature === undefined || signature === "") {
    return undefined;
  }
  return { timestamp, signature };
}

export function signWebhookPayload(
  secret: string,
  timestamp: number,
  body: string,
): string {
  if (secret === "") {
    throw new RangeError("Webhook secret must not be empty");
  }
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new RangeError("Webhook timestamp must be a non-negative integer");
  }
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(
  options: WebhookSignatureOptions,
): boolean {
  if (options.secret === "" || !options.header) {
    return false;
  }

  const toleranceSeconds =
    options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError("toleranceSeconds must be a non-negative integer");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(now) || now < 0) {
    throw new RangeError("now must be a non-negative integer");
  }

  const parsed = parseSignatureHeader(options.header);
  if (!parsed) {
    return false;
  }
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = createHmac("sha256", options.secret)
    .update(`${parsed.timestamp}.${options.body}`)
    .digest();
  const actual = Buffer.from(parsed.signature, "hex");
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

export class WebhookReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: WebhookReplayGuardOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_REPLAY_MAX_ENTRIES;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive integer");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.seen.size;
  }

  accept(eventId: string, now = Date.now()): boolean {
    if (eventId === "") {
      return false;
    }
    this.prune(now);
    const expiresAt = this.seen.get(eventId);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    this.seen.set(eventId, now + this.ttlMs);
    this.evictOverflow();
    return true;
  }

  reset(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [eventId, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(eventId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.seen.size > this.maxEntries) {
      let oldestId: string | undefined;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [eventId, expiresAt] of this.seen) {
        if (expiresAt < oldestExpiry) {
          oldestId = eventId;
          oldestExpiry = expiresAt;
        }
      }
      if (oldestId === undefined) {
        return;
      }
      this.seen.delete(oldestId);
    }
  }
}
