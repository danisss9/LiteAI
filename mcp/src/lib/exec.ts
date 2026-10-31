import { execFile } from "node:child_process";

// One way to run things, used by every tool: execFile with an argv array (no
// shell anywhere), a timeout on everything, and a result object that always
// resolves - command failures are data, not exceptions, because "pacman -Qi
// unknown-package exits 1" is an answer, not an error.

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const MAX_BUFFER = 8 * 1024 * 1024;

export function run(command: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
    return new Promise((resolve) => {
        execFile(
            command,
            args,
            { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
            (error, stdout, stderr) => {
                const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
                if (code === "ENOENT") {
                    resolve({
                        code: 127,
                        stdout: "",
                        stderr: `${command}: not found on this system`,
                        timedOut: false,
                    });
                    return;
                }
                const err = error as (Error & { code?: unknown; killed?: boolean; signal?: string }) | null;
                resolve({
                    code: err === null ? 0 : typeof err?.code === "number" ? err.code : 1,
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                    timedOut: Boolean(err?.killed && err?.signal === "SIGTERM"),
                });
            },
        );
    });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
