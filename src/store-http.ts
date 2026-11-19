const DEFAULT_TIMEOUT_MS = 10_000;

export interface RemoteStoreOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class RemoteStoreError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
  }
}

export interface RemoteStoreResponse {
  status: number;
  body: unknown;
}

function errorMessage(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return undefined;
}

export function ensureOk(response: RemoteStoreResponse): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new RemoteStoreError(
      response.status,
      errorMessage(response.body) ?? `Remote store returned ${response.status}`,
      response.body,
    );
  }
  return response.body;
}

export class RemoteStoreClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RemoteStoreOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RangeError("Remote store url must use http or https");
    }
    if (url.search !== "" || url.hash !== "") {
      throw new RangeError(
        "Remote store url must not include a query or fragment",
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new RangeError("Remote store url must not include credentials");
    }
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? (fetch as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RemoteStoreResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (this.token !== undefined) {
        headers.authorization = `Bearer ${this.token}`;
      }
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body, (_key, value) =>
                typeof value === "bigint" ? value.toString() : value,
              ),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new RemoteStoreError(
            response.status,
            "Remote store returned invalid JSON",
          );
        }
      }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }
}
