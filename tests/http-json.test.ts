import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  HttpRequestError,
  optionalBigInt,
  optionalString,
  readJson,
  requireObject,
  requiredBigInt,
  requiredNumber,
  requiredPositiveInteger,
  requiredString,
} from "../src/http-json.js";

function request(
  body: string | Buffer[],
  contentType = "application/json",
): IncomingMessage {
  const chunks = typeof body === "string" ? [Buffer.from(body)] : body;
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.headers = { "content-type": contentType };
  return stream;
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof HttpRequestError ? error.status : undefined;
  }
  return undefined;
}

describe("readJson", () => {
  it("parses a JSON body", async () => {
    await expect(readJson(request('{"a":1}'), 1024)).resolves.toEqual({
      a: 1,
    });
  });

  it("returns an empty object for an empty body", async () => {
    await expect(readJson(request(""), 1024)).resolves.toEqual({});
  });

  it("rejects a body that is not JSON with 400", async () => {
    expect(await statusOf(() => readJson(request("{nope"), 1024))).toBe(400);
  });

  it("rejects a wrong content type with 415", async () => {
    expect(
      await statusOf(() => readJson(request("{}", "text/plain"), 1024)),
    ).toBe(415);
  });

  it("rejects a request without a content type with 415", async () => {
    const stream = Readable.from([]) as unknown as IncomingMessage;
    stream.headers = {};
    expect(await statusOf(() => readJson(stream, 1024))).toBe(415);
  });

  it("rejects a body over the limit with 413", async () => {
    expect(await statusOf(() => readJson(request("x".repeat(20)), 10))).toBe(
      413,
    );
  });

  it("accepts string chunks from the stream", async () => {
    const stream = Readable.from(['{"a":', "2}"]) as unknown as IncomingMessage;
    stream.headers = { "content-type": "application/json" };
    await expect(readJson(stream, 1024)).resolves.toEqual({ a: 2 });
  });
});

describe("requireObject", () => {
  it("returns an object", () => {
    expect(requireObject({ a: 1 })).toEqual({ a: 1 });
  });

  it.each([[null], [[]], ["text"], [3]])("rejects %j with 400", (value) => {
    expect(() => requireObject(value)).toThrow(HttpRequestError);
  });
});

describe("string fields", () => {
  it("returns an optional string when present", () => {
    expect(optionalString({ a: "x" }, "a")).toBe("x");
  });

  it("returns undefined for a missing or null optional string", () => {
    expect(optionalString({}, "a")).toBeUndefined();
    expect(optionalString({ a: null }, "a")).toBeUndefined();
  });

  it("rejects a blank or non-string value", () => {
    expect(() => optionalString({ a: "  " }, "a")).toThrow(
      "a must be a non-empty string",
    );
    expect(() => optionalString({ a: 4 }, "a")).toThrow(HttpRequestError);
  });

  it("requires a string", () => {
    expect(requiredString({ a: "x" }, "a")).toBe("x");
    expect(() => requiredString({}, "a")).toThrow("a is required");
  });
});

describe("integer fields", () => {
  it("reads a bigint from a bigint, digit string, or safe integer", () => {
    expect(requiredBigInt({ a: 5n }, "a")).toBe(5n);
    expect(requiredBigInt({ a: "12" }, "a")).toBe(12n);
    expect(requiredBigInt({ a: 7 }, "a")).toBe(7n);
  });

  it.each([
    ["-1"],
    ["1.5"],
    [-3],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 2],
    [true],
  ])("rejects %j as a bigint", (value) => {
    expect(() => requiredBigInt({ a: value }, "a")).toThrow(
      "a must be a non-negative integer",
    );
  });

  it("treats a missing or null optional bigint as undefined", () => {
    expect(optionalBigInt({}, "a")).toBeUndefined();
    expect(optionalBigInt({ a: null }, "a")).toBeUndefined();
    expect(optionalBigInt({ a: "9" }, "a")).toBe(9n);
  });

  it("reads a number from a safe integer or digit string", () => {
    expect(requiredNumber({ a: 4 }, "a")).toBe(4);
    expect(requiredNumber({ a: "8" }, "a")).toBe(8);
  });

  it.each([[-1], [1.5], ["abc"], ["99999999999999999999"], [undefined]])(
    "rejects %j as a number",
    (value) => {
      expect(() => requiredNumber({ a: value }, "a")).toThrow(HttpRequestError);
    },
  );

  it("requires a positive integer", () => {
    expect(requiredPositiveInteger({ a: 3 }, "a")).toBe(3);
    expect(() => requiredPositiveInteger({ a: 0 }, "a")).toThrow(
      "a must be positive",
    );
  });
});
