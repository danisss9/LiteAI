import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/exec.js";
import { parseEnvFile } from "../lib/conf.js";
import { readTextFile, writeTextFile, removeFile } from "../lib/files.js";
import { runHelper } from "../lib/priv.js";
import {
    isVersion, isPiConfigFile, isExtensionRelativePath, scopedPath,
    sanitizeText, formatBytes,
} from "../lib/validate.js";
import { text, errText, tool, READ_ONLY, DESTRUCTIVE } from "../lib/results.js";

// pi itself: status, configuration and extensions.
//
// These tools exist so the model can improve the agent it is running inside of.
// pi's native read/edit tools could technically touch the same files, but these
// gate them behind a whitelist, a size ceiling and path scoping - and they make
// the capability visible in the tool list, which is what invites the model to
// use it. Config and extension changes take effect when the human runs /reload.

const PI_VERSION_FILE = "/usr/share/liteai/pi-version";

function agentDir(): string {
    return join(homedir(), ".pi", "agent");
}

function extensionsDir(): string {
    return join(agentDir(), "extensions");
}

async function listTree(base: string, depth: number): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, prefix: string, level: number): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const rel = prefix + entry.name;
            if (entry.isDirectory()) {
                out.push(`${rel}/`);
                if (level < depth) {
                    await walk(join(dir, entry.name), `${rel}/`, level + 1);
                }
            } else if (entry.isFile()) {
                out.push(rel);
            }
        }
    }
    await walk(base, "", 0);
    return out.sort();
}

async function summarizeConfig(): Promise<string> {
    const lines: string[] = [];
    try {
        const models = JSON.parse(await readTextFile(join(agentDir(), "models.json"), 256 * 1024)) as {
            providers?: Record<string, { baseUrl?: string; models?: Array<{ id?: string }> }>;
        };
        for (const [name, provider] of Object.entries(models.providers ?? {})) {
            const ids = (provider.models ?? []).map((m) => m.id ?? "?").join(", ");
            lines.push(`provider ${name}: ${provider.baseUrl ?? "?"} -> [${ids}]`);
        }
    } catch { /* no models.json is possible mid-setup */ }
    try {
        const mcp = JSON.parse(await readTextFile(join(agentDir(), "mcp.json"), 256 * 1024)) as {
            mcpServers?: Record<string, unknown>;
        };
        lines.push(`mcp servers: ${Object.keys(mcp.mcpServers ?? {}).join(", ") || "(none)"}`);
    } catch { /* ditto */ }
    return lines.join("\n");
}

export function registerPiTools(server: McpServer): void {
    tool(server, "pi_status", {
        title: "pi status",
        description:
            "Report on pi itself: the installed version, the node version, what is configured in "
            + "~/.pi/agent (providers, models, MCP servers) and what extensions and skills exist. "
            + "Always safe to call.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const lines: string[] = [];
        try {
            const v = parseEnvFile(await readTextFile(PI_VERSION_FILE, 16 * 1024));
            lines.push(`pi: ${v.version ?? "unknown"} (staged from ${v.package ?? "?"})`);
        } catch {
            lines.push("pi: version file missing");
        }
        lines.push(`node: ${process.version}`);

        const r = await run("pi", ["--version"], 15_000);
        if (r.code === 0 && r.stdout.trim()) {
            lines.push(`pi reports: ${r.stdout.trim().split("\n")[0]}`);
        }

        const summary = await summarizeConfig();
        if (summary) {
            lines.push(summary);
        }

        const [extensions, skills] = await Promise.all([
            listTree(extensionsDir(), 3),
            listTree(join(agentDir(), "skills"), 3),
        ]);
        lines.push(`extensions/: ${extensions.length > 0 ? "" : "(empty)"}`);
        lines.push(...extensions.map((p) => `  ${p}`));
        lines.push(`skills/: ${skills.length > 0 ? "" : "(empty)"}`);
        lines.push(...skills.map((p) => `  ${p}`));
        lines.push("", "Config changes apply after the human runs /reload in pi.");
        return text(sanitizeText(lines.join("\n"), 20_000));
    });

    tool(server, "pi_config_get", {
        title: "Read pi configuration",
        description:
            "Read one of pi's own configuration files: AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, "
            + "settings.json, models.json, mcp.json or keybindings.json.",
        inputSchema: {
            file: z.string().describe("The file name, e.g. models.json or AGENTS.md"),
        },
        annotations: READ_ONLY,
    }, async ({ file }) => {
        if (!isPiConfigFile(file)) {
            return errText(`file not allowed: ${file}`);
        }
        const path = join(agentDir(), file);
        const content = await readTextFile(path);
        return text(sanitizeText(content, 200_000));
    });

    tool(server, "pi_config_set", {
        title: "Write pi configuration",
        description:
            "Rewrite one of pi's own configuration files (same list as pi_config_get). JSON files are "
            + "validated before writing. Takes effect after the human runs /reload - say so when you "
            + "use this. You are editing the agent you are running inside of; be careful and explain "
            + "what you changed.",
        inputSchema: {
            file: z.string().describe("The file name to rewrite"),
            content: z.string().optional().describe("The full new file content"),
            json: z.unknown().optional().describe("Alternatively: a JSON value to write (pretty-printed)"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ file, content, json }) => {
        if (!isPiConfigFile(file)) {
            return errText(`file not allowed: ${file}`);
        }
        if (content === undefined && json === undefined) {
            return errText("give either content (string) or json (any value)");
        }
        if (content !== undefined && json !== undefined) {
            return errText("give content or json, not both");
        }
        let body: string;
        if (json !== undefined) {
            body = `${JSON.stringify(json, null, 2)}\n`;
        } else {
            const raw = content as string;
            if (file.endsWith(".json")) {
                try {
                    JSON.parse(raw);
                } catch (e) {
                    return errText(`refusing to write invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            body = raw;
        }
        const path = join(agentDir(), file);
        await writeTextFile(path, sanitizeText(body, 512 * 1024));
        return text(`wrote ${path} (${formatBytes(Buffer.byteLength(body))}). The human must run /reload in pi for this to take effect.`);
    });

    tool(server, "pi_extension_list", {
        title: "List pi extensions and skills",
        description: "List the files under ~/.pi/agent/extensions and ~/.pi/agent/skills.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const extensions = await listTree(extensionsDir(), 4);
        const skills = await listTree(join(agentDir(), "skills"), 4);
        const lines = [
            `${extensionsDir()}:`,
            ...(extensions.length > 0 ? extensions.map((p) => `  ${p}`) : ["  (empty)"]),
            `${join(agentDir(), "skills")}:`,
            ...(skills.length > 0 ? skills.map((p) => `  ${p}`) : ["  (empty)"]),
        ];
        return text(lines.join("\n"));
    });

    tool(server, "pi_extension_read", {
        title: "Read a pi extension file",
        description: "Read one file from ~/.pi/agent/extensions (a relative path, e.g. my-ext/index.ts).",
        inputSchema: {
            path: z.string().describe("Path relative to the extensions directory"),
        },
        annotations: READ_ONLY,
    }, async ({ path: relative }) => {
        const base = extensionsDir();
        const resolved = scopedPath(base, relative);
        if (resolved === null) {
            return errText(`path escapes the extensions directory: ${relative}`);
        }
        const content = await readTextFile(resolved);
        return text(sanitizeText(content, 200_000));
    });

    tool(server, "pi_extension_write", {
        title: "Write a pi extension file",
        description:
            "Create or rewrite a file under ~/.pi/agent/extensions (TypeScript/JavaScript/markdown/json). "
            + "This is how you extend yourself: write the extension, then ask the human to run /reload. "
            + "Explain what you changed.",
        inputSchema: {
            path: z.string().describe("Path relative to the extensions directory"),
            content: z.string().describe("The full new file content"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ path: relative, content }) => {
        if (!isExtensionRelativePath(relative)) {
            return errText(`path not allowed: ${relative} (relative, no '..' extensions .ts .js .mjs .cjs .md .json)`);
        }
        const base = extensionsDir();
        const resolved = scopedPath(base, relative);
        if (resolved === null) {
            return errText(`path escapes the extensions directory: ${relative}`);
        }
        await writeTextFile(resolved, sanitizeText(content, 512 * 1024));
        return text(`wrote ${resolved} (${formatBytes(Buffer.byteLength(content))}). The human must run /reload in pi to load it.`);
    });

    tool(server, "pi_extension_delete", {
        title: "Delete a pi extension file",
        description: "Delete one file under ~/.pi/agent/extensions. Tell the human what you removed.",
        inputSchema: {
            path: z.string().describe("Path relative to the extensions directory"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ path: relative }) => {
        const base = extensionsDir();
        const resolved = scopedPath(base, relative);
        if (resolved === null || resolved === base) {
            return errText(`path not allowed: ${relative}`);
        }
        await removeFile(resolved);
        return text(`deleted ${resolved}. The human must run /reload in pi for the removal to take effect.`);
    });

    tool(server, "pi_update", {
        title: "Update pi",
        description:
            "Install a new version of pi itself through the privileged liteai-pi helper (npm install -g "
            + "@earendil-works/pi-coding-agent). Omit version for latest. The running session keeps its "
            + "old version until restarted.",
        inputSchema: {
            version: z.string().optional().describe("A version or dist-tag, e.g. 1.4.0; omit for latest"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ version }) => {
        if (version !== undefined && !isVersion(version)) {
            return errText(`not a version or dist-tag: ${version}`);
        }
        const args = version === undefined ? ["update"] : ["update", version];
        const r = await runHelper("liteai-pi", args, 600_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`pi update failed:\n${r.stderr || r.stdout}`, 6000));
        }
        return text(sanitizeText(r.stdout, 6000));
    });
}
