import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

// Tool plumbing shared by every module: result constructors, the annotation
// vocabulary, and a `safe` wrapper so no handler can ever take the server
// process down - a tool that throws is a tool that reports, not a crash,
// because this server is the only interface pi has to the machine.

export function text(t: string): CallToolResult {
    return { content: [{ type: "text", text: t }] };
}

export function errText(t: string): CallToolResult {
    return { content: [{ type: "text", text: t }], isError: true };
}

// Read-only tools: pi runs these without asking the human.
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

// Read-only but talks to the network (Hugging Face, llama-server on localhost
// does not need this).
export const READ_ONLY_NET: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

// Changes state without destroying anything (wifi_connect).
export const ACTION: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// The human should confirm these: they destroy data, restart services, spend
// gigabytes or turn the machine off.
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// Destructive and network-using (model_download, system_update).
export const DESTRUCTIVE_NET: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function tool<S extends z.ZodRawShape>(
    server: McpServer,
    name: string,
    config: {
        title?: string;
        description?: string;
        inputSchema?: S;
        annotations?: ToolAnnotations;
    },
    handler: (args: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
    // The SDK's registerTool is generic over a schema type parameter that
    // collapses under Parameters<>, so the boundary call goes through one
    // deliberately loose cast; everything on this side of it - the shape of
    // config and the inferred handler arguments - stays fully typed and is
    // exercised by the test suite.
    type Loose = (name: string, config: unknown, cb: unknown) => unknown;
    const wrapped = async (args: z.output<z.ZodObject<S>>) => {
        try {
            return await handler(args ?? ({} as z.output<z.ZodObject<S>>));
        } catch (e) {
            return errText(e instanceof Error ? e.message : String(e));
        }
    };
    (server.registerTool as unknown as Loose)(name, config, wrapped);
}
