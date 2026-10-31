import os from "node:os";
import { statfsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/exec.js";
import { fetchJson } from "../lib/http.js";
import { runHelper } from "../lib/priv.js";
import {
    isPackageName, normalizeUnitName, formatBytes, sanitizeText,
} from "../lib/validate.js";
import { text, errText, tool, READ_ONLY, ACTION, DESTRUCTIVE, DESTRUCTIVE_NET } from "../lib/results.js";

// The base system: what kind of machine this is, its network, its power, its
// services, its logs and its packages. Reads run as the user (the liteai
// account is in the systemd-journal group, so journalctl works); the one
// privileged write, system_update, goes through the liteai-update helper.

const SERVICE = "liteai-llama";

function parseMeminfo(): { total: number | null; available: number | null } {
    try {
        const text = readFileSync("/proc/meminfo", "utf8");
        const total = /MemTotal:\s+(\d+) kB/.exec(text);
        const available = /MemAvailable:\s+(\d+) kB/.exec(text);
        return {
            total: total ? Number(total[1]) * 1024 : null,
            available: available ? Number(available[1]) * 1024 : null,
        };
    } catch {
        return { total: null, available: null };
    }
}

export function registerSystemTools(server: McpServer): void {
    tool(server, "system_info", {
        title: "System information",
        description:
            "One-stop report on this machine: OS, uptime, memory (free vs total - check before model "
            + "upgrades), the root filesystem, load, the local model server state, and the primary "
            + "network addresses. Always safe to call.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const lines: string[] = [
            `host: ${os.hostname()} (${os.type()} ${os.release()}, ${os.arch()})`,
            `uptime: ${(os.uptime() / 3600).toFixed(1)} h, load: ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}`,
        ];

        const mem = parseMeminfo();
        const total = mem.total ?? os.totalmem();
        const available = mem.available ?? os.freemem();
        lines.push(`memory: ${formatBytes(available)} available of ${formatBytes(total)}`);

        try {
            const fsInfo = statfsSync("/");
            lines.push(`disk /: ${formatBytes(fsInfo.bavail * fsInfo.bsize)} free of ${formatBytes(fsInfo.blocks * fsInfo.bsize)}`);
        } catch {
            lines.push("disk /: unknown");
        }

        try {
            const r = await run("systemctl", ["is-active", SERVICE]);
            lines.push(`model server: ${r.stdout.trim() || r.stderr.trim()}`);
        } catch {
            lines.push("model server: unknown (no systemd here)");
        }
        try {
            await fetchJson("http://127.0.0.1:8080/health", 2000);
            lines.push("model server http: ok");
        } catch {
            lines.push("model server http: no answer");
        }

        try {
            const r = await run("ip", ["-brief", "address", "show"]);
            lines.push("", sanitizeText(r.stdout.trim(), 2000));
        } catch { /* ip is not everywhere; the summary stands without it */ }

        return text(lines.join("\n"));
    });

    tool(server, "wifi_list", {
        title: "List Wi-Fi networks",
        description: "Scan for Wi-Fi networks through NetworkManager and list them with signal strength.",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const r = await run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list"], 45_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`nmcli failed:\n${r.stderr || r.stdout}`, 3000));
        }
        const rows = r.stdout.trim().split("\n")
            .filter((l) => l.length > 0)
            .map((l) => {
                // -t output is colon-separated, but SSIDs may contain colons;
                // take the last three fields and treat the rest as the SSID.
                const parts = l.split(":");
                if (parts.length < 4) return l;
                const security = parts.pop() ?? "";
                const signal = parts.pop() ?? "";
                const inUse = parts.shift() ?? "";
                return `${inUse === "*" || inUse === "yes" ? "*" : " "} ${parts.join(":")}  ${signal}%  ${security}`;
            });
        return text(rows.length > 0 ? rows.join("\n") : "no networks found");
    });

    tool(server, "wifi_connect", {
        title: "Join a Wi-Fi network",
        description:
            "Connect this machine to a Wi-Fi network with NetworkManager. On a headless machine a "
            + "wrong name means the human has to fix it at the console, so confirm the exact network "
            + "name (and password) with them first.",
        inputSchema: {
            ssid: z.string().min(1).max(64).describe("The network name (SSID)"),
            password: z.string().max(128).optional().describe("The password; omit for open networks"),
        },
        annotations: ACTION,
    }, async ({ ssid, password }) => {
        const args = ["device", "wifi", "connect", ssid];
        if (password !== undefined) {
            args.push("password", password);
        }
        const r = await run("nmcli", args, 60_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`connection failed:\n${r.stderr || r.stdout}`, 3000));
        }
        return text(sanitizeText(r.stdout.trim() || "connected", 3000));
    });

    tool(server, "power", {
        title: "Power off, reboot or suspend",
        description:
            "Turn the machine off, reboot it, or suspend it. This ends your own session - tell the "
            + "human what is about to happen and let them confirm before calling it.",
        inputSchema: {
            action: z.enum(["off", "reboot", "suspend"]).describe("off = power off, reboot = restart, suspend = sleep"),
        },
        annotations: DESTRUCTIVE,
    }, async ({ action }) => {
        const verb = action === "off" ? "poweroff" : action;
        const r = await run("systemctl", [verb], 15_000);
        if (r.timedOut) {
            // systemctl suspend blocks until the machine wakes again; the
            // timeout killing the client does not undo the suspend itself.
            return text(`suspend initiated (this tool stopped waiting - that is expected).`);
        }
        if (r.code !== 0) {
            return errText(sanitizeText(`systemctl ${verb} failed:\n${r.stderr || r.stdout}`, 3000));
        }
        return text(`${verb} initiated.`);
    });

    tool(server, "service_status", {
        title: "Service status",
        description:
            "systemctl status for one unit. Allowed units: liteai-* services, NetworkManager, sshd, "
            + "systemd-timesyncd. Read-only.",
        inputSchema: {
            unit: z.string().describe("The unit name, e.g. liteai-llama or NetworkManager"),
        },
        annotations: READ_ONLY,
    }, async ({ unit }) => {
        const normalized = normalizeUnitName(unit);
        if (normalized === null) {
            return errText(`unit not allowed: ${unit} (liteai-*, NetworkManager, sshd, systemd-timesyncd)`);
        }
        const r = await run("systemctl", ["status", normalized, "--no-pager", "--lines=20"]);
        // status exits non-zero for an inactive unit, which is an answer.
        const body = sanitizeText(`${r.stdout}${r.stderr}`.trim() || `(${normalized} is inactive)`, 8000);
        return text(body);
    });

    tool(server, "logs_tail", {
        title: "Tail system logs",
        description:
            "Show the last lines of the system journal, optionally for one unit (same whitelist as "
            + "service_status). Read-only; the liteai account is in the systemd-journal group.",
        inputSchema: {
            lines: z.coerce.number().int().min(1).max(200).default(50).describe("How many lines (max 200)"),
            unit: z.string().optional().describe("Only this unit's logs, e.g. liteai-llama"),
        },
        annotations: READ_ONLY,
    }, async ({ lines: count, unit }) => {
        const args = ["journalctl", "-n", String(count), "--no-pager"];
        if (unit !== undefined) {
            const normalized = normalizeUnitName(unit);
            if (normalized === null) {
                return errText(`unit not allowed: ${unit} (liteai-*, NetworkManager, sshd, systemd-timesyncd)`);
            }
            args.push("-u", normalized);
        }
        const r = await run(args[0], args.slice(1), 30_000);
        if (r.code !== 0) {
            return errText(sanitizeText(`journalctl failed:\n${r.stderr || r.stdout}`, 3000));
        }
        return text(sanitizeText(r.stdout, 60_000));
    });

    tool(server, "package_query", {
        title: "Query packages",
        description:
            "Read-only pacman queries: 'info' shows an installed package, 'search' searches the "
            + "repositories, 'installed' lists everything. Never syncs the package database.",
        inputSchema: {
            action: z.enum(["info", "search", "installed"]),
            name: z.string().optional().describe("Package name (info) or search term (search)"),
        },
        annotations: READ_ONLY,
    }, async ({ action, name }) => {
        let args: string[];
        if (action === "info") {
            if (name === undefined || !isPackageName(name)) {
                return errText("info needs a valid package name");
            }
            args = ["pacman", "-Qi", name];
        } else if (action === "search") {
            if (name === undefined || !isPackageName(name)) {
                return errText("search needs a valid name or term");
            }
            args = ["pacman", "-Ss", name];
        } else {
            args = ["pacman", "-Q"];
        }
        const r = await run(args[0], args.slice(1), 60_000);
        if (r.code !== 0 && action !== "info") {
            return errText(sanitizeText(`pacman failed:\n${r.stderr || r.stdout}`, 3000));
        }
        const out = `${r.stdout}${r.stderr}`.trim();
        return text(sanitizeText(out || "(no output - not installed?)", 60_000));
    });

    tool(server, "system_update", {
        title: "Update the system",
        description:
            "Run the full Arch update (pacman -Syu) through the privileged liteai-update helper. "
            + "Long-running; confirm with the human first. Reboot afterwards if the kernel changed.",
        inputSchema: {},
        annotations: DESTRUCTIVE_NET,
    }, async () => {
        const r = await runHelper("liteai-update", ["update"], 3_600_000);
        const summary = sanitizeText(`${r.stdout}\n${r.stderr}`.trim(), 60_000);
        if (r.code !== 0) {
            return errText(`update failed:\n${summary}`);
        }
        return text(summary);
    });
}
