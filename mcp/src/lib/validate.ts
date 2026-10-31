import { resolve, sep, basename, extname } from "node:path";

// The validation vocabulary of the whole server, in one place and fully
// unit-tested. Every tool funnels its arguments through these before anything
// is executed, written or deleted: the pkexec helpers re-validate on the root
// side too, but a friendly rejection here saves a round trip through pkexec.

export const GGUF_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;
export const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
export const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;

// The keys /etc/liteai/llama.conf is allowed to carry; the liteai-llama helper
// enforces the same list on the root side.
export const CONF_KEYS = ["MODEL", "ALIAS", "CTX", "THREADS", "EXTRA_ARGS"] as const;
export type ConfKey = (typeof CONF_KEYS)[number];

export function isConfKey(key: string): key is ConfKey {
    return (CONF_KEYS as readonly string[]).includes(key);
}

// A bare file name, and nothing but one: no path components, no dot tricks.
export function isGgufFileName(name: string): boolean {
    return GGUF_FILE_RE.test(name) && !name.includes("..");
}

export function isHfRepo(repo: string): boolean {
    return HF_REPO_RE.test(repo);
}

// A semver string or an npm dist-tag, nothing shell-shaped.
export function isVersion(version: string): boolean {
    return VERSION_RE.test(version);
}

export function isPackageName(name: string): boolean {
    return PACKAGE_NAME_RE.test(name);
}

// systemd units the tools are allowed to talk about. Everything else returns
// null and the tool refuses; the .service suffix is normalised away first.
const UNIT_RE = /^(liteai-[a-z][a-z-]*|NetworkManager|sshd|systemd-timesyncd)$/;

export function normalizeUnitName(unit: string): string | null {
    const bare = unit.replace(/\.service$/, "");
    if (!UNIT_RE.test(bare)) {
        return null;
    }
    return `${bare}.service`;
}

// The files under ~/.pi/agent the AI may rewrite through pi_config. Deliberately
// a fixed list, not a pattern: extensions have their own tool, and everything
// else in there (auth.json above all) is not the model's business.
export const PI_CONFIG_FILES = [
    "AGENTS.md",
    "AGENTS.override.md",
    "APPEND_SYSTEM.md",
    "SYSTEM.md",
    "settings.json",
    "mcp.json",
    "models.json",
    "keybindings.json",
] as const;

export function isPiConfigFile(name: string): boolean {
    return (PI_CONFIG_FILES as readonly string[]).includes(name);
}

// Extension sources pi may manage through pi_extension. The character set is
// tight because these become module paths pi imports.
const EXTENSION_EXT_RE = /^\.(ts|js|mjs|cjs|md|json)$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isExtensionRelativePath(relative: string): boolean {
    if (relative.includes("..") || relative.includes("\0")) {
        return false;
    }
    if (!EXTENSION_EXT_RE.test(extname(relative))) {
        return false;
    }
    return relative.split(/[\\/]+/).every((segment) => segment.length > 0 && SEGMENT_RE.test(segment));
}

// Resolve `relative` under `base`, or null when it would escape. This is the
// only path join the write-capable tools may use.
export function scopedPath(base: string, relative: string): string | null {
    if (relative.includes("\0")) {
        return null;
    }
    const resolved = resolve(base, relative);
    const baseWithSep = base.endsWith(sep) ? base : base + sep;
    if (resolved !== base && !resolved.startsWith(baseWithSep)) {
        return null;
    }
    return resolved;
}

// Strip control characters (keeping newline and tab) and cap the length: tool
// output goes into a model context window, and a file read that returns two
// megabytes of NULs is worse than one that returns a polite error.
export function sanitizeText(text: string, maxLen: number): string {
    const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}\n... (truncated at ${maxLen} characters)`;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "?";
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function fileNameOf(p: string): string {
    return basename(p);
}
