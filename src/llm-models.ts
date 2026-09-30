/** `npm run llm-models`: list model ids the configured endpoint offers. Prints ids only, never the key. */
import { loadDotenv } from "./env.js";
import { llmConfigFromEnv, redact } from "./llm.js";

loadDotenv();
const cfg = llmConfigFromEnv();
const res = await fetch(`${cfg.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
const text = await res.text();
if (!res.ok) {
  console.log(`http ${res.status}: ${redact(text, cfg.apiKey).slice(0, 300)}`);
  process.exit(1);
}
const data = JSON.parse(text) as { data?: Array<{ id: string }> };
const ids = (data.data ?? []).map((m) => m.id.replace(/^models\//, "")).filter((id) => /gemini/.test(id)).sort();
console.log(ids.join("\n"));
