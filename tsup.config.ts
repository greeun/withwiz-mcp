import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "tokens/index": "src/tokens/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: false,
  splitting: false,
  clean: true,
  treeshake: true,
  target: "node22",
  platform: "node",
  external: ["@modelcontextprotocol/sdk", "zod", /^@withwiz\/toolkit/],
});
