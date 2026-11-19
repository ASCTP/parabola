import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpRequestError(415, "Content-Type must be application/json");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new HttpRequestError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Request body is not valid JSON");
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function optionalString(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpRequestError(400, `${name} must be a non-empty string`);
  }
  return value;
}

export function requiredString(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = optionalString(body, name);
  if (value === undefined) {
    throw new HttpRequestError(400, `${name} is required`);
  }
  return value;
}

export function requiredBigInt(
  body: Record<string, unknown>,
  name: string,
): bigint {
  const value = body[name];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new HttpRequestError(400, `${name} must be a non-negative integer`);
}

export function optionalBigInt(
  body: Record<string, unknown>,
  name: string,
): bigint | undefined {
  if (body[name] === undefined || body[name] === null) {
    return undefined;
  }
  return requiredBigInt(body, name);
}

export function requiredNumber(
  body: Record<string, unknown>,
  name: string,
): number {
  const value = body[name];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new HttpRequestError(400, `${name} must be a non-negative integer`);
}

export function requiredPositiveInteger(
  body: Record<string, unknown>,
  name: string,
): number {
  const value = requiredNumber(body, name);
  if (value <= 0) {
    throw new HttpRequestError(400, `${name} must be positive`);
  }
  return value;
}
