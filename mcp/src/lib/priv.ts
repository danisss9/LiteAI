import { run, type RunResult } from "./exec.js";

// How the server reaches the privileged helpers.
//
// The helpers live in /usr/local/bin and are pkexec-able: polkit answers
// without a password for exactly those four programs, but only for a local,
// active wheel session - which is what pi runs as on this machine. Running as
// root already (or off-platform, for the smoke tests) drops the pkexec step.

const HELPER_DIR = "/usr/local/bin";

export function helperCommand(
    name: string,
    args: string[],
    opts: { platform?: NodeJS.Platform; isRoot?: boolean } = {},
): { command: string; args: string[] } {
    const platform = opts.platform ?? process.platform;
    const isRoot = opts.isRoot ?? (typeof process.getuid === "function" ? process.getuid() === 0 : false);
    const program = `${HELPER_DIR}/${name}`;
    if (platform !== "linux" || isRoot) {
        return { command: program, args };
    }
    return { command: "pkexec", args: [program, ...args] };
}

export function runHelper(
    name: string,
    args: string[],
    timeoutMs = 60_000,
): Promise<RunResult> {
    const { command, args: full } = helperCommand(name, args);
    return run(command, full, timeoutMs);
}
