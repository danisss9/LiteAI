import { mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { formatBytes } from "./validate.js";

// File helpers with size ceilings: the server runs inside a model's context
// budget, so nothing it reads may be unbounded, and everything it writes is
// written through its parent directory existing first.

const DEFAULT_MAX_READ = 512 * 1024;
const DEFAULT_MAX_WRITE = 512 * 1024;

export async function readTextFile(path: string, maxBytes = DEFAULT_MAX_READ): Promise<string> {
    const info = await stat(path);
    if (!info.isFile()) {
        throw new Error(`${path} is not a regular file`);
    }
    if (info.size > maxBytes) {
        throw new Error(`${path} is ${formatBytes(info.size)}; refusing to read more than ${formatBytes(maxBytes)}`);
    }
    return readFile(path, "utf8");
}

export async function writeTextFile(path: string, content: string, maxBytes = DEFAULT_MAX_WRITE): Promise<void> {
    const payload = Buffer.from(content, "utf8");
    if (payload.byteLength > maxBytes) {
        throw new Error(`refusing to write ${formatBytes(payload.byteLength)}; the limit is ${formatBytes(maxBytes)}`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, payload, { mode: 0o644 });
}

export async function removeFile(path: string): Promise<void> {
    await unlink(path);
}
