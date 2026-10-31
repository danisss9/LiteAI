// Small JSON fetch with a timeout. llama-server answers three localhost
// endpoints (health, /v1/models) that every llama_* tool leans on; a dead or
// loading server must surface as a catchable rejection within seconds, never
// as a hang.

export async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            throw new Error(`${url} answered ${res.status}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}
