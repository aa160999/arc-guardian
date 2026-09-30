/**
 * Minimal OpenAI-compatible chat client (works with Gemini's OpenAI endpoint,
 * OpenAI, DeepSeek, OpenRouter, …). No SDK, no dependency. The key is read from
 * env and never logged.
 */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.LLM_API_KEY ?? "";
  if (!apiKey) throw new Error("LLM_API_KEY is empty in .env");
  return {
    apiKey,
    baseUrl: (env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
    model: env.LLM_MODEL ?? "gemini-3.8-flash",
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(cfg: LlmConfig, messages: ChatMessage[], opts: { json?: boolean; temperature?: number; timeoutMs?: number } = {}): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`llm http ${res.status}: ${redact(text, cfg.apiKey).slice(0, 500)}`);
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("llm returned no content");
    return content;
  } finally {
    clearTimeout(t);
  }
}

export function redact(s: string, secret: string): string {
  return secret ? s.split(secret).join("[REDACTED]") : s;
}

/** `npm run llm-ping`: proves the key/model work without printing the key. */
if (process.argv[1] && /llm\.(ts|js)$/.test(process.argv[1])) {
  const { loadDotenv } = await import("./env.js");
  loadDotenv();
  let cfg: LlmConfig;
  try {
    cfg = llmConfigFromEnv();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
  const started = Date.now();
  try {
    const out = await chat(cfg, [{ role: "user", content: "Reply with exactly: GUARDIAN_OK" }], { timeoutMs: 30_000 });
    console.log(JSON.stringify({ ok: out.includes("GUARDIAN_OK"), model: cfg.model, baseUrl: cfg.baseUrl, keyPrefix: cfg.apiKey.slice(0, 4) + "…", reply: out.trim().slice(0, 80), ms: Date.now() - started }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, model: cfg.model, baseUrl: cfg.baseUrl, keyPrefix: cfg.apiKey.slice(0, 4) + "…", error: redact(e instanceof Error ? e.message : String(e), cfg.apiKey) }));
    process.exitCode = 1;
  }
}
