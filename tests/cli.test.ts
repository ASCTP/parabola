import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli.js";
import { main } from "../src/cli.js";
import type { TransferRecord } from "../src/execution/contracts.js";
import { FileTransferStore } from "../src/execution/file-store.js";

const RECIPIENT =
  "GCY3PLGZQZWVKQELW7GCHQVLVZGRMGI5R4HODX6QZM7ETJSPHBFVJPY2";

let directory: string;
let cursorDirectory: string;

function capture(): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr.push(String(chunk));
          return true;
        },
      },
    },
    stdout,
    stderr,
  };
}

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    idempotencyKey: "order-1",
    phase: "planned",
    from: "arc",
    to: "stellar",
    network: "mainnet",
    amount: "10",
    recipient: RECIPIENT,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "parabola-cli-"));
  cursorDirectory = await mkdtemp(join(tmpdir(), "parabola-cursors-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(cursorDirectory, { recursive: true, force: true });
});

describe("parabola CLI", () => {
  it("prints usage with no command", async () => {
    const output = capture();

    await expect(main([], output.io)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("Usage: parabola");
  });

  it("prints usage for the help command", async () => {
    const output = capture();

    await expect(main(["help"], output.io)).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("Commands:");
  });

  it("rejects an unknown command", async () => {
    const output = capture();

    await expect(main(["nope"], output.io)).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Unknown command: nope");
  });

  it("lists an empty store", async () => {
    const output = capture();

    await expect(
      main(["list", "--store-dir", directory], output.io),
    ).resolves.toBe(0);
    expect(output.stdout.join("")).toContain("No transfers.");
  });

  it("lists records as JSON", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());
    const output = capture();

    await expect(
      main(["list", "--store-dir", directory, "--json"], output.io),
    ).resolves.toBe(0);
    const parsed = JSON.parse(output.stdout.join("")) as TransferRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.idempotencyKey).toBe("order-1");
  });

  it("reconciles burn evidence into the store", async () => {
    const store = new FileTransferStore(directory);
    await store.create(record());
    const output = capture();

    await expect(
      main(
        [
          "reconcile",
          "--store-dir",
          directory,
          "--key",
          "order-1",
          "--burn-tx",
          "burn-1",
        ],
        output.io,
      ),
    ).resolves.toBe(0);

    expect(output.stdout.join("")).toContain("order-1: burned (changed)");
    expect(await store.get("order-1")).toMatchObject({
      phase: "burned",
      burnTxHash: "burn-1",
    });
  });

  it("requires evidence for reconcile", async () => {
    const output = capture();

    await expect(
      main(
        ["reconcile", "--store-dir", directory, "--key", "order-1"],
        output.io,
      ),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("At least one of --burn-tx");
  });

  it("requires a burn hash for resolve", async () => {
    const output = capture();

    await expect(
      main(["resolve", "--from", "arc"], output.io),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Missing required option --burn-tx");
  });

  it("rejects an invalid resolve source", async () => {
    const output = capture();

    await expect(
      main(
        ["resolve", "--from", "solana", "--burn-tx", "burn-1"],
        output.io,
      ),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("--from must be arc or stellar");
  });

  it("requires an indexer start position for sync", async () => {
    const output = capture();

    await expect(
      main(
        [
          "sync",
          "--store-dir",
          directory,
          "--cursor-dir",
          cursorDirectory,
        ],
        output.io,
      ),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain(
      "At least one of --arc-start-block or --stellar-start-ledger",
    );
  });

  it("rejects an invalid network before touching a chain", async () => {
    const output = capture();

    await expect(
      main(
        [
          "sync",
          "--store-dir",
          directory,
          "--cursor-dir",
          cursorDirectory,
          "--arc-start-block",
          "1",
          "--network",
          "devnet",
        ],
        output.io,
      ),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain(
      "--network must be mainnet or testnet",
    );
  });

  it("rejects disabling every configured stream", async () => {
    const output = capture();

    await expect(
      main(
        [
          "sync",
          "--store-dir",
          directory,
          "--cursor-dir",
          cursorDirectory,
          "--arc-start-block",
          "1",
          "--no-arc-burns",
          "--no-arc-mints",
        ],
        output.io,
      ),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain(
      "At least one indexer stream must be configured",
    );
  });

  it("rejects unknown options", async () => {
    const output = capture();

    await expect(
      main(["list", "--store-dir", directory, "--bogus"], output.io),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Unknown option: --bogus");
  });

  it("rejects unexpected positional arguments", async () => {
    const output = capture();

    await expect(
      main(["list", "extra"], output.io),
    ).resolves.toBe(1);
    expect(output.stderr.join("")).toContain("Unexpected argument: extra");
  });

  it("runs the store server until a signal arrives", async () => {
    const { io, stdout } = capture();
    const running = main(
      [
        "store",
        "--store-dir",
        directory,
        "--cursor-dir",
        cursorDirectory,
        "--port",
        "0",
      ],
      io,
    );

    for (let attempt = 0; attempt < 100 && stdout.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const match = /Listening on (\S+)/.exec(stdout.join(""));
    expect(match).not.toBeNull();
    const response = await fetch(`${match?.[1]}/health`);
    expect(response.status).toBe(200);

    process.emit("SIGINT");
    await expect(running).resolves.toBe(0);
  });

  it("rejects unknown store options", async () => {
    const { io, stderr } = capture();
    await expect(main(["store", "--bogus", "1"], io)).resolves.toBe(1);
    expect(stderr.join("")).toContain("Unknown option: --bogus");
  });
});
