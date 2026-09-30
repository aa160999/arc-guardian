/**
 * `npm run tts` — narrate video/script.json with Gemini TTS → data/video/audio/<scene>.wav
 * Runs where the LLM key lives. Uses the native Gemini REST endpoint (the OpenAI-compatible
 * one has no TTS). The key is never printed. Skips scenes whose wav already exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotenv } from "./env.js";
import { redact } from "./llm.js";

loadDotenv();
const key = process.env.LLM_API_KEY ?? "";
if (!key) {
  console.log(JSON.stringify({ ok: false, error: "LLM_API_KEY empty" }));
  process.exit(1);
}
const model = process.env.TTS_MODEL ?? "gemini-3.8-flash-tts";
const script = JSON.parse(readFileSync("video/script.json", "utf8")) as { voice?: string; scenes: Array<{ id: string; narration: string }> };
const voice = process.env.TTS_VOICE ?? script.voice ?? "Kore";
const outDir = "data/video/audio";
mkdirSync(outDir, { recursive: true });
const force = process.argv.includes("--force");

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const results: Array<{ id: string; ok: boolean; bytes?: number; seconds?: number; error?: string }> = [];
for (const s of script.scenes) {
  const out = join(outDir, `${s.id}.wav`);
  if (existsSync(out) && !force) {
    results.push({ id: s.id, ok: true, bytes: readFileSync(out).length });
    continue;
  }
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: s.narration }] }], // no style prefix: this model reads instructions aloud
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`http ${res.status}: ${redact(text, key).slice(0, 300)}`);
    const j = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("no audio in response: " + redact(text, key).slice(0, 200));
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
    const pcm = Buffer.from(part.inlineData.data, "base64");
    const wav = /wav/i.test(part.inlineData.mimeType ?? "") ? pcm : wavFromPcm16(pcm, rate);
    writeFileSync(out, wav);
    results.push({ id: s.id, ok: true, bytes: wav.length, seconds: Math.round((pcm.length / 2 / rate) * 10) / 10 });
  } catch (e) {
    results.push({ id: s.id, ok: false, error: redact(e instanceof Error ? e.message : String(e), key) });
  }
}
console.log(JSON.stringify({ model, voice, results }, null, 2));
if (results.some((r) => !r.ok)) process.exitCode = 1;
