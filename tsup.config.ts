import { defineConfig } from "tsup";

// `dist` is removed by the `build` script rather than by `clean: true`, because
// these configs can run concurrently and a clean here would race with — and
// delete — the output of the others.
export default defineConfig([
  // Browser library.
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    minify: true,
    target: "es2017",
    platform: "browser",
    treeshake: true,
    sourcemap: false,
  },
  // Collector server, exposed as `console-daijin/server` for programmatic use.
  {
    entry: ["src/server.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    minify: false,
    target: "node20",
    platform: "node",
    tsconfig: "tsconfig.node.json",
    treeshake: true,
    sourcemap: false,
  },
  // CLI entry point (`console-daijin-server`). Not minified: readable stack
  // traces matter more than bytes for a local dev tool.
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    minify: false,
    target: "node20",
    platform: "node",
    tsconfig: "tsconfig.node.json",
    treeshake: true,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
