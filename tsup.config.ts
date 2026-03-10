import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  minify: true,
  target: "es2017",
  platform: "browser",
  treeshake: true,
  sourcemap: false,
});
