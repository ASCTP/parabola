import { describe, expect, it } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WebhookReplayGuard,
} from "../../src/webhooks/signature.js";

const SECRET = "whsec_test";
const BODY = JSON.stringify({ id: "evt_1", type: "transfer.minted" });
const NOW = 1_700_000_000;

describe("webhook signatures", () => {
  it("signs and verifies a payload", () => {
    const header = signWebhookPayload(SECRET, NOW, BODY);

    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signWebhookPayload(SECRET, NOW, BODY);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: `${BODY} `,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signWebhookPayload(SECRET, NOW, BODY);

    expect(
      verifyWebhookSignature({
        secret: "whsec_other",
        header,
        body: BODY,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance", () => {
    const header = signWebhookPayload(SECRET, NOW, BODY);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY,
        now: NOW + 301,
      }),
    ).toBe(false);
  });

  it("accepts a timestamp inside a custom tolerance", () => {
    const header = signWebhookPayload(SECRET, NOW, BODY);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header,
        body: BODY,
        now: NOW + 30,
        toleranceSeconds: 60,
      }),
    ).toBe(true);
  });

  it("rejects malformed, missing, and empty secrets", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: "nope",
        body: BODY,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: null,
        body: BODY,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: "",
        header: signWebhookPayload(SECRET, NOW, BODY),
        body: BODY,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects invalid signing input", () => {
    expect(() => signWebhookPayload("", NOW, BODY)).toThrow(RangeError);
    expect(() => signWebhookPayload(SECRET, -1, BODY)).toThrow(
      RangeError,
    );
    expect(() => signWebhookPayload(SECRET, 1.5, BODY)).toThrow(
      RangeError,
    );
  });
});

describe("webhook replay guard", () => {
  it("rejects a duplicate event inside the ttl", () => {
    const guard = new WebhookReplayGuard({ ttlMs: 1_000 });

    expect(guard.accept("evt_1", 10_000)).toBe(true);
    expect(guard.accept("evt_1", 10_500)).toBe(false);
    expect(guard.accept("evt_1", 11_000)).toBe(true);
  });

  it("accepts distinct events and rejects empty ids", () => {
    const guard = new WebhookReplayGuard();

    expect(guard.accept("evt_1", 1)).toBe(true);
    expect(guard.accept("evt_2", 1)).toBe(true);
    expect(guard.accept("", 1)).toBe(false);
  });

  it("evicts the oldest entries when the cap is reached", () => {
    const guard = new WebhookReplayGuard({
      ttlMs: 10_000,
      maxEntries: 2,
    });

    expect(guard.accept("evt_1", 1_000)).toBe(true);
    expect(guard.accept("evt_2", 2_000)).toBe(true);
    expect(guard.accept("evt_3", 3_000)).toBe(true);
    expect(guard.size).toBe(2);
    expect(guard.accept("evt_1", 3_001)).toBe(true);
  });

  it("clears recorded events on reset", () => {
    const guard = new WebhookReplayGuard();
    guard.accept("evt_1", 1);

    guard.reset();

    expect(guard.size).toBe(0);
    expect(guard.accept("evt_1", 1)).toBe(true);
  });

  it("rejects invalid options", () => {
    expect(() => new WebhookReplayGuard({ ttlMs: 0 })).toThrow(
      RangeError,
    );
    expect(
      () => new WebhookReplayGuard({ maxEntries: 0 }),
    ).toThrow(RangeError);
  });
});
