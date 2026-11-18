import { assertChainAdapterConforms } from "../conformance/chain-adapter.js";
import type { ChainAdapter } from "../kernel/contracts.js";
import type { ChainId } from "../types.js";

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export class ChainAdapterRegistry {
  private readonly adapters = new Map<ChainId, ChainAdapter>();

  constructor(adapters: Iterable<ChainAdapter> = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ChainAdapter): this {
    assertChainAdapterConforms(adapter);
    if (this.adapters.has(adapter.chain)) {
      throw new ProviderRegistryError(
        `A chain adapter is already registered for ${adapter.chain}`,
      );
    }
    this.adapters.set(adapter.chain, adapter);
    return this;
  }

  has(chain: ChainId): boolean {
    return this.adapters.has(chain);
  }

  get(chain: ChainId): ChainAdapter | undefined {
    return this.adapters.get(chain);
  }

  require(chain: ChainId): ChainAdapter {
    const adapter = this.get(chain);
    if (!adapter) {
      throw new ProviderRegistryError(
        `No chain adapter is registered for ${chain}`,
      );
    }
    return adapter;
  }

  chains(): ChainId[] {
    return [...this.adapters.keys()];
  }

  toRecord(): Record<ChainId, ChainAdapter> {
    return {
      arc: this.require("arc"),
      stellar: this.require("stellar"),
    };
  }
}
