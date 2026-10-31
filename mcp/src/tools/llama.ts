import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, sleep } from "../lib/exec.js";
import { fetchJson } from "../lib/http.js";
import { parseEnvFile } from "../lib/conf.js";
import { readTextFile } from "../lib/files.js";
import { runHelper } from "../lib/priv.js";
import { isConfKey, isGgufFileName, isHfRepo, formatBytes, sanitizeText } from "../lib/validate.js";
import { text, errText, tool, READ_ONLY, READ_ONLY_NET, DESTRUCTIVE, DESTRUCTIVE_NET } from "../lib/results.js";

// llama.cpp: status, control, configuration and the model library.
//
// The read paths talk to systemctl (as the user - status needs no privilege)
// and to llama-server's own localhost HTTP API. Everything that changes state
// goes through the liteai-llama / liteai-models helpers via pkexec, which
// validate the same arguments again on the root side.

const SERVICE = "liteai-llama";
const BASE_URL = "http://127.0.0.1:8080";
const CONF_PATH = "/etc/liteai/llama.conf";
const MODELS_DIR = "/var/lib/liteai/models";

async function readConf(): Promise<Record<string, string>> {
    try {
        return parseEnvFile(await readTextFile(CONF_PATH, 64 * 1024));
    } catch {
        return {};
    }
}

async function llamaServerModel(): Promise<string | null> {
    try {
        const data = (await fetchJson(`${BASE_URL}/v1/models`, 3000)) as { data?: Array<{ id?: string }> };
        return data?.data?.[0]?.id ?? null;
    } catch {
        return null;
    }
}

export function registerLlamaTools(server: McpServer): void {
    tool(server, "llama_status", {
        title: "llama-server status",
        description:
            "Report on the local model server: systemd state of liteai-llama, its memory use, "
            + "whether /health answers, which model alias it is serving, and which model file "
            + "/etc/liteai/llama.conf points at. Always safe to call.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const [svc, health, served, conf] = await Promise.allSettled([
            run("systemctl", ["show", SERVICE, "--property=ActiveState,SubState,MainPID,MemoryCurrent,NRestarts"]),
            fetchJson(`${BASE_URL}/health`, 3000),
            llamaServerModel(),
            readConf(),
        ]);

        const lines: string[] = [];
        if (svc.status === "fulfilled") {
            const props = new Map(
                svc.value.stdout.trim().split("\n").map((l) => {
                    const eq = l.indexOf("=");
                    return eq > 0 ? [l.slice(0, eq), l.slice(eq + 1)] : [l, ""];
                }),
            );
            const memRaw = props.get("MemoryCurrent") ?? "";
            const mem = /^\d+$/.test(memRaw) ? ` (${formatBytes(Number(memRaw))} RSS)` : "";
            lines.push(
                `service: ${props.get("ActiveState") ?? "?"}/${props.get("SubState") ?? "?"}${mem}`,
                `main pid: ${props.get("MainPID") ?? "?"}, restarts: ${props.get("NRestarts") ?? "?"}`,
            );
        } else {
            lines.push(`service: unknown (${svc.reason?.message ?? "systemctl failed"} - not a Linux machine?)`);
        }

        lines.push(`http health: ${health.status === "fulfilled" ? "ok" : "no answer"}`);
        lines.push(`serving: ${served.status === "fulfilled" && served.value ? served.value : "(nothing - not loaded)"}`);

        if (conf.status === "fulfilled") {
            const c = conf.value;
            lines.push(
                `configured file: ${c.MODEL ?? "?"} (alias ${c.ALIAS ?? "?"}, ctx ${c.CTX ?? "?"})`,
            );
            if (served.status === "fulfilled" && served.value && c.ALIAS && served.value !== c.ALIAS) {
                lines.push(`note: the served alias (${served.value}) does not match llama.conf (${c.ALIAS}) - restart may be pending`);
            }
        }

        lines.push("", `Model library: use model_list. Logs: journalctl -u ${SERVICE} via logs_tail.`);
        return text(lines.join("\n"));
    });

    tool(server, "llama_restart", {
        title: "Restart llama-server",
        description:
            "Restart the liteai-llama systemd service (asks the human via pi's permission flow). "
            + "Waits until /health answers again, up to 60s. Use after a configuration change that "
            + "the liteai-llama helper did not already restart for.",
        inputSchema: {},
        annotations: DESTRUCTIVE,
    }, async () => {
        const r = await runHelper("liteai-llama", ["restart"], 120_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`liteai-llama restart failed:\n${r.stderr || r.stdout}`, 4000));
        }
        for (let i = 0; i < 60; i += 1) {
            try {
                await fetchJson(`${BASE_URL}/health`, 2000);
                return text(`llama-server restarted and healthy after ${i + 1}s.`);
            } catch {
                await sleep(1000);
            }
        }
        return errText("the service restarted but /health is not answering after 60s - check logs_tail for journalctl -u liteai-llama");
    });

    tool(server, "llama_config_get", {
        title: "Read llama-server configuration",
        description: "Read /etc/liteai/llama.conf: the served model file, its alias, context size, threads and extra flags.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const conf = await readConf();
        const keys = ["MODEL", "ALIAS", "CTX", "THREADS", "EXTRA_ARGS"];
        const body = keys.map((k) => `${k}=${conf[k] ?? "(unset)"}`).join("\n");
        return text(`${CONF_PATH}:\n${body}\n\nChange with llama_config_set; llama_config_set restarts the service.`);
    });

    tool(server, "llama_config_set", {
        title: "Change llama-server configuration",
        description:
            "Set one key in /etc/liteai/llama.conf (MODEL, ALIAS, CTX, THREADS or EXTRA_ARGS) and restart "
            + "llama-server. MODEL must be an existing file in /var/lib/liteai/models. The alias is what "
            + "pi's models.json refers to, so changing ALIAS means updating models.json too (pi_config_set).",
        inputSchema: {
            key: z.string().describe("One of MODEL, ALIAS, CTX, THREADS, EXTRA_ARGS"),
            value: z.string().describe("The new value; see the helper's rules in /etc/liteai/llama.conf"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ key, value }) => {
        if (!isConfKey(key)) {
            return errText(`unknown key: ${key} (allowed: MODEL, ALIAS, CTX, THREADS, EXTRA_ARGS)`);
        }
        const r = await runHelper("liteai-llama", ["set", key, value], 120_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`rejected:\n${r.stderr || r.stdout}`, 4000));
        }
        return text(sanitizeText(`${r.stdout}\nIf the alias changed, update ~/.pi/agent/models.json (pi_config_set) and run /model in pi.`, 6000));
    });

    tool(server, "model_list", {
        title: "List local models",
        description: "List the .gguf files in /var/lib/liteai/models with sizes, plus which one is served.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const conf = await readConf();
        let entries: Array<{ name: string; size: string; meta: string }> = [];
        try {
            const names = (await readdir(MODELS_DIR)).filter((n) => n.endsWith(".gguf")).sort();
            entries = await Promise.all(names.map(async (name) => {
                const info = await stat(join(MODELS_DIR, name));
                let meta = "";
                try {
                    const parsed = parseEnvFile(await readTextFile(join(MODELS_DIR, `${name}.meta`), 16 * 1024));
                    if (parsed.url) meta = `\n    from: ${parsed.url}`;
                } catch { /* a model without provenance is fine */ }
                return { name, size: formatBytes(info.size), meta };
            }));
        } catch {
            return errText(`${MODELS_DIR} is not readable from here (${process.platform})`);
        }
        const lines = entries.map((e) => `  ${e.name}  [${e.size}]${e.meta}`);
        return text(
            `served now: ${conf.MODEL ?? "?"} (alias ${conf.ALIAS ?? "?"})\n`
            + `${MODELS_DIR}:\n${lines.length > 0 ? lines.join("\n") : "  (empty)"}\n\n`
            + `Download more with model_download; switch with model_default.`,
        );
    });

    tool(server, "model_download", {
        title: "Download a model",
        description:
            "Download a .gguf model from huggingface.co into /var/lib/liteai/models. Takes the repository "
            + "(owner/repo) and the file name, e.g. repo 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', file "
            + "'qwen2.5-coder-7b-instruct-q4_k_m.gguf'. Resumable; a partial download never looks like a "
            + "finished model. Large files take minutes to hours - agree on the file with the human first.",
        inputSchema: {
            repo: z.string().describe("Hugging Face repository: owner/repo"),
            file: z.string().describe("The .gguf file name inside that repository"),
        },
        annotations: DESTRUCTIVE_NET,
    }, async ({ repo, file }) => {
        if (!isHfRepo(repo)) {
            return errText(`not an owner/repo pair: ${repo} (example: Qwen/Qwen2.5-Coder-7B-Instruct-GGUF)`);
        }
        if (!isGgufFileName(file)) {
            return errText(`not a .gguf file name: ${file}`);
        }
        const r = await runHelper("liteai-models", ["download", repo, file], 3_600_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`download failed:\n${r.stderr || r.stdout}`, 6000));
        }
        return text(sanitizeText(r.stdout, 6000));
    });

    tool(server, "model_remove", {
        title: "Remove a model",
        description:
            "Delete a .gguf file (and its checksum/provenance side files) from /var/lib/liteai/models. "
            + "Refuses the model llama-server is currently serving - switch first with model_default.",
        inputSchema: {
            file: z.string().describe("The .gguf file name to delete"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ file }) => {
        if (!isGgufFileName(file)) {
            return errText(`not a .gguf file name: ${file}`);
        }
        const r = await runHelper("liteai-models", ["remove", file], 60_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`refused:\n${r.stderr || r.stdout}`, 4000));
        }
        return text(sanitizeText(r.stdout, 4000));
    });

    tool(server, "model_default", {
        title: "Serve a different model",
        description:
            "Point /etc/liteai/llama.conf at a downloaded .gguf file and restart llama-server. The alias "
            + "becomes the file name without .gguf; after switching, update ~/.pi/agent/models.json "
            + "(pi_config_set) so pi can pick the new model with /model.",
        inputSchema: {
            file: z.string().describe("The .gguf file name to serve"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ file }) => {
        if (!isGgufFileName(file)) {
            return errText(`not a .gguf file name: ${file}`);
        }
        const r = await runHelper("liteai-models", ["default", file], 180_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`refused:\n${r.stderr || r.stdout}`, 4000));
        }
        return text(sanitizeText(r.stdout, 6000));
    });
}
