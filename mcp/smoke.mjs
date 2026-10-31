// Smoke-test the built MCP server over stdio, without a pi or a model server:
// initialize, list tools, and call the tools that answer everywhere (the
// read-only ones degrade gracefully off a Linux box - that degradation is part
// of what this checks).
//
//   node smoke.mjs          (build first: npm run build)

import { spawn } from "node:child_process";

const proc = spawn(process.execPath, ["out/server.cjs"], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    }
});

proc.on("exit", (code) => {
    console.log(`server exited with ${code}`);
    process.exit(code === 0 || code === null ? 0 : 1);
});

function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
        timer.unref();
    });
}

function firstText(result) {
    const block = result?.content?.find((c) => c.type === "text");
    return block ? block.text : "(no text)";
}

const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "liteai-smoke", version: "0.0.0" },
});
console.log(`initialize: serverInfo=${JSON.stringify(init.result?.serverInfo)}`);
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const listed = await send("tools/list", {});
const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
console.log(`tools/list: ${names.length} tools`);
console.log(names.map((n) => `  ${n}`).join("\n"));

for (const name of ["system_info", "llama_config_get", "model_list"]) {
    const call = await send("tools/call", { name, arguments: {} });
    const isError = call.result?.isError === true;
    console.log(`--- tools/call ${name}${isError ? " (isError - expected off a LiteAI machine)" : ""}`);
    console.log(firstText(call.result));
}

proc.stdin.end();
