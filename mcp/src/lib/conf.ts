// Parser for /etc/liteai/llama.conf, a systemd EnvironmentFile: KEY=value
// lines, '#' comments, optional surrounding quotes on values. Writes go
// through the liteai-llama helper (the file is root-owned); reads are free.

export type LlamaConf = Record<string, string>;

export function parseEnvFile(text: string): LlamaConf {
    const out: LlamaConf = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }
        const eq = line.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
            || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
