// Build the LiteAI MCP server (and its test bundle).
//
// Everything - the MCP SDK and zod included - is compiled into one CommonJS
// file, because the machine that runs it has only the system node and a
// read-only /usr/share. Usage:
//
//   node esbuild.mjs           build both
//   node esbuild.mjs server    only out/server.cjs (what the image ships)
//   node esbuild.mjs test      only out/test.cjs   (what `npm test` runs)

import { build } from "esbuild";

const which = process.argv[2] ?? "all";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

if (which === "all" || which === "server") {
  await build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "out/server.cjs",
  });
}

if (which === "all" || which === "test") {
  await build({
    ...shared,
    entryPoints: ["test/index.test.ts"],
    outfile: "out/test.cjs",
  });
}
