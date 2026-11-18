import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/execution/index.ts",
    "src/indexer/index.ts",
    "src/runtime.ts",
    "src/api.ts",
    "src/observability.ts",
    "src/conformance/index.ts",
    "src/providers/index.ts",
    "src/cli-entry.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
