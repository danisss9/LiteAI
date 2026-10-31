// LiteAI MCP server.
//
// Runs under the system node, speaks MCP over stdio (that is what pi spawns),
// and exposes the machine to the model: llama.cpp and its model library, pi's
// own configuration and extensions, and the base system's network, power,
// services, logs and packages.
//
// Nothing here prints to stdout except the MCP protocol - stdout belongs to
// the transport, which is why there is not a single console.log below.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLlamaTools } from "./tools/llama.js";
import { registerSystemTools } from "./tools/system.js";
import { registerPiTools } from "./tools/pi.js";

const server = new McpServer(
    { name: "liteai", version: "1.0.0" },
    { instructions:
        "Tools for managing this LiteAI machine: the local llama.cpp model server and its model "
        + "library, pi's own configuration and extensions, and the base system (network, power, "
        + "services, logs, packages). Read-only tools are annotated as such; anything marked "
        + "destructive stops for the human's confirmation first. Config and extension changes need "
        + "a /reload in pi to take effect." },
);

registerLlamaTools(server);
registerSystemTools(server);
registerPiTools(server);

// CommonJS output cannot carry top-level await, and the transport is the whole
// point of the process: if connecting fails there is nothing to fall back to.
async function main(): Promise<void> {
    await server.connect(new StdioServerTransport());
}

main().catch((e) => {
    process.stderr.write(`liteai mcp server: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
