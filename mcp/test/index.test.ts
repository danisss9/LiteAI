// Tests for the LiteAI MCP server's pure logic: the validation vocabulary, the
// EnvironmentFile parser and the pkexec decision. Everything that touches real
// commands is excluded on purpose - the server's job on a real machine is to
// shell out, and that is what the image smoke test (and the machine itself)
// exercises.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
    isConfKey, isGgufFileName, isHfRepo, isVersion, isPackageName,
    normalizeUnitName, isPiConfigFile, isExtensionRelativePath,
    scopedPath, sanitizeText, formatBytes,
} from "../src/lib/validate.js";
import { parseEnvFile } from "../src/lib/conf.js";
import { helperCommand } from "../src/lib/priv.js";

describe("validate - model names", () => {
    test("accepts plain gguf file names", () => {
        assert.equal(isGgufFileName("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"), true);
        assert.equal(isGgufFileName("Model-7B.Q4_K_M.gguf"), true);
    });

    test("rejects path tricks", () => {
        assert.equal(isGgufFileName("../etc/passwd.gguf"), false);
        assert.equal(isGgufFileName("a/b.gguf"), false);
        assert.equal(isGgufFileName("..gguf"), false);
        assert.equal(isGgufFileName(".gguf"), false);
        assert.equal(isGgufFileName("model.bin"), false);
        assert.equal(isGgufFileName(""), false);
        assert.equal(isGgufFileName("model.gguf\n"), false);
    });
});

describe("validate - huggingface repos", () => {
    test("accepts owner/repo", () => {
        assert.equal(isHfRepo("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF"), true);
        assert.equal(isHfRepo("ggml-org/models"), true);
        assert.equal(isHfRepo("a.b-c/d_e"), true);
    });

    test("rejects everything else", () => {
        assert.equal(isHfRepo("just-a-name"), false);
        assert.equal(isHfRepo("/leading"), false);
        assert.equal(isHfRepo("trailing/"), false);
        assert.equal(isHfRepo("a/b/c"), false);
        assert.equal(isHfRepo(""), false);
        assert.equal(isHfRepo("a b/c"), false);
    });
});

describe("validate - misc patterns", () => {
    test("conf keys are a fixed set", () => {
        assert.equal(isConfKey("MODEL"), true);
        assert.equal(isConfKey("ALIAS"), true);
        assert.equal(isConfKey("CTX"), true);
        assert.equal(isConfKey("THREADS"), true);
        assert.equal(isConfKey("EXTRA_ARGS"), true);
        assert.equal(isConfKey("model"), false);
        assert.equal(isConfKey("HOST"), false);
        assert.equal(isConfKey(""), false);
    });

    test("versions look like versions", () => {
        assert.equal(isVersion("1.4.0"), true);
        assert.equal(isVersion("latest"), true);
        assert.equal(isVersion("1.2.3-beta.1"), true);
        assert.equal(isVersion("rm -rf /"), false);
        assert.equal(isVersion("1.4.0; echo"), false);
        assert.equal(isVersion(""), false);
    });

    test("package names are plain", () => {
        assert.equal(isPackageName("nodejs"), true);
        assert.equal(isPackageName("python-pip"), true);
        assert.equal(isPackageName("python-pip; echo"), false);
        assert.equal(isPackageName(""), false);
        assert.equal(isPackageName("-flag"), false);
    });
});

describe("validate - systemd units", () => {
    test("whitelists and normalises", () => {
        assert.equal(normalizeUnitName("liteai-llama"), "liteai-llama.service");
        assert.equal(normalizeUnitName("liteai-llama.service"), "liteai-llama.service");
        assert.equal(normalizeUnitName("NetworkManager"), "NetworkManager.service");
        assert.equal(normalizeUnitName("NetworkManager.service"), "NetworkManager.service");
        assert.equal(normalizeUnitName("sshd"), "sshd.service");
        assert.equal(normalizeUnitName("systemd-timesyncd"), "systemd-timesyncd.service");
    });

    test("refuses everything else", () => {
        assert.equal(normalizeUnitName("sshd.socket"), null);
        assert.equal(normalizeUnitName("networkmanager"), null);
        assert.equal(normalizeUnitName("docker"), null);
        assert.equal(normalizeUnitName("liteai-llama; reboot"), null);
        assert.equal(normalizeUnitName(""), null);
        assert.equal(normalizeUnitName("../shadow"), null);
    });
});

describe("validate - pi files", () => {
    test("config whitelist is exact", () => {
        assert.equal(isPiConfigFile("models.json"), true);
        assert.equal(isPiConfigFile("AGENTS.md"), true);
        assert.equal(isPiConfigFile("../auth.json"), false);
        assert.equal(isPiConfigFile("auth.json"), false);
        assert.equal(isPiConfigFile("extensions/x.ts"), false);
    });

    test("extension paths are relative, whitelisted and traversal-free", () => {
        assert.equal(isExtensionRelativePath("my-ext/index.ts"), true);
        assert.equal(isExtensionRelativePath("README.md"), true);
        assert.equal(isExtensionRelativePath("a/b/c.json"), true);
        assert.equal(isExtensionRelativePath("../escape.ts"), false);
        assert.equal(isExtensionRelativePath("sub/../../escape.ts"), false);
        assert.equal(isExtensionRelativePath("/etc/passwd"), false);
        assert.equal(isExtensionRelativePath("no-ext"), false);
        assert.equal(isExtensionRelativePath("binary.exe"), false);
        assert.equal(isExtensionRelativePath(""), false);
        assert.equal(isExtensionRelativePath("trailing/"), false);
    });
});

describe("validate - scopedPath", () => {
    const base = join(tmpdir(), "liteai-scoped-test");

    test("resolves inside the base", () => {
        assert.equal(scopedPath(base, "a/b.txt"), join(base, "a/b.txt"));
        assert.equal(scopedPath(base, "a/../b.txt"), join(base, "b.txt"));
    });

    test("rejects escapes", () => {
        assert.equal(scopedPath(base, "../outside"), null);
        assert.equal(scopedPath(base, join(sep, "etc/passwd")), null);
        assert.equal(scopedPath(base, ".."), null);
    });
});

describe("validate - text safety", () => {
    test("strips control characters but keeps newlines and tabs", () => {
        assert.equal(sanitizeText("a\u0000b\u0007c\nd\te", 100), "abc\nd\te");
    });

    test("caps length with a marker", () => {
        const out = sanitizeText("x".repeat(100), 10);
        assert.ok(out.startsWith("xxxxxxxxxx"));
        assert.ok(out.includes("truncated"));
    });

    test("formats bytes", () => {
        assert.equal(formatBytes(0), "0 B");
        assert.equal(formatBytes(512), "512 B");
        assert.equal(formatBytes(2048), "2.0 KiB");
        assert.equal(formatBytes(1.12 * 1024 * 1024 * 1024), "1.1 GiB");
        assert.equal(formatBytes(Number.NaN), "?");
    });
});

describe("conf - parseEnvFile", () => {
    test("parses keys, comments and blanks", () => {
        const conf = parseEnvFile(
            "# a comment\nMODEL=qwen.gguf\n\nALIAS=qwen2.5-coder-1.5b\nCTX=8192\n",
        );
        assert.deepEqual(conf, {
            MODEL: "qwen.gguf",
            ALIAS: "qwen2.5-coder-1.5b",
            CTX: "8192",
        });
    });

    test("unquotes values", () => {
        const conf = parseEnvFile('A="quoted value"\nB=\'single\'\nC=plain');
        assert.equal(conf.A, "quoted value");
        assert.equal(conf.B, "single");
        assert.equal(conf.C, "plain");
    });

    test("keeps the first = only", () => {
        const conf = parseEnvFile("EXTRA_ARGS=--flash-attn -fa 1");
        assert.equal(conf.EXTRA_ARGS, "--flash-attn -fa 1");
    });

    test("ignores junk lines", () => {
        assert.deepEqual(parseEnvFile("noequals\n=emptykey\n  # comment\n\n"), {});
    });
});

describe("priv - helper command choice", () => {
    test("wraps in pkexec for an unprivileged linux session", () => {
        const { command, args } = helperCommand("liteai-llama", ["restart"], { platform: "linux", isRoot: false });
        assert.equal(command, "pkexec");
        assert.deepEqual(args, ["/usr/local/bin/liteai-llama", "restart"]);
    });

    test("runs directly as root", () => {
        const { command, args } = helperCommand("liteai-models", ["list"], { platform: "linux", isRoot: true });
        assert.equal(command, "/usr/local/bin/liteai-models");
        assert.deepEqual(args, ["list"]);
    });

    test("runs directly off-platform (smoke tests)", () => {
        const { command } = helperCommand("liteai-pi", ["version"], { platform: "win32", isRoot: false });
        assert.equal(command, "/usr/local/bin/liteai-pi");
    });
});
