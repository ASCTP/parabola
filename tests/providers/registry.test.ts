import { describe, expect, it } from "vitest";
import {
  ChainAdapterRegistry,
  ProviderRegistryError,
} from "../../src/providers/registry.js";
import { fakeChainAdapter } from "../helpers/fake-chain-adapter.js";

describe("chain adapter registry", () => {
  it("registers adapters and resolves them by chain", () => {
    const arc = fakeChainAdapter("arc");
    const stellar = fakeChainAdapter("stellar");
    const registry = new ChainAdapterRegistry([arc, stellar]);

    expect(registry.has("arc")).toBe(true);
    expect(registry.has("stellar")).toBe(true);
    expect(registry.get("arc")).toBe(arc);
    expect(registry.require("stellar")).toBe(stellar);
    expect(registry.chains()).toEqual(["arc", "stellar"]);
  });

  it("builds a complete chain record", () => {
    const arc = fakeChainAdapter("arc");
    const stellar = fakeChainAdapter("stellar");
    const registry = new ChainAdapterRegistry([arc, stellar]);

    expect(registry.toRecord()).toEqual({ arc, stellar });
  });

  it("rejects a duplicate chain adapter", () => {
    const registry = new ChainAdapterRegistry([fakeChainAdapter("arc")]);

    expect(() => registry.register(fakeChainAdapter("arc"))).toThrow(
      ProviderRegistryError,
    );
  });

  it("rejects an adapter that does not conform", () => {
    const registry = new ChainAdapterRegistry();
    const adapter = {
      ...fakeChainAdapter("arc"),
      burn: undefined,
    } as unknown as ReturnType<typeof fakeChainAdapter>;

    expect(() => registry.register(adapter)).toThrow(/burn must be a function/);
  });

  it("reports a missing adapter instead of returning undefined", () => {
    const registry = new ChainAdapterRegistry();

    expect(registry.get("arc")).toBeUndefined();
    expect(() => registry.require("arc")).toThrow(
      /No chain adapter is registered for arc/,
    );
    expect(() => registry.toRecord()).toThrow(ProviderRegistryError);
  });
});
