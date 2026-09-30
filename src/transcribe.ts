/** `npm run transcribe -- <wav>`: ask the configured Gemini model to transcribe a wav verbatim (QA for TTS output). */
import { readFileSync } from "node:fs";
import { loadDotenv } from "./env.js";
import { redact } from "./llm.js";

loadDotenv();
const key = process.env.LLM_API_KEY ?? "";
const model = process.env.LLM_MODEL ?? "gemini-3.5-flash-lite";
const file = process.argv[2];
if (!key || !file) {
  console.log(JSON.stringify({ ok: false, error: !key ? "LLM_API_KEY empty" : "usage: transcribe <wav>" }));
  process.exit(1);
}
const b64 = readFileSync(file).toString("base64");
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": key },
  body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: b64 } }, { text: "Transcribe this audio verbatim, word for word, including anything spoken before the main content. Output only the transcript." }] }] }),
});
const text = await res.text();
if (!res.ok) {
  console.log(JSON.stringify({ ok: false, error: `http ${res.status}: ${redact(text, key).slice(0, 300)}` }));
  process.exit(1);
}
const j = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
console.log(JSON.stringify({ ok: true, file, transcript: j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "" }, null, 2));
