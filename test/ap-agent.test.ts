import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fxUsdPer, matchVendor, runAp, type ApOptions } from "../src/ap-agent.js";
import type { ChatMessage, LlmConfig } from "../src/llm.js";
import { parsePolicy } from "../src/policy.js";

const POLICY = parsePolicy(readFileSync(join(__dirname, "..", "policy.yaml"), "utf8"));
const CFG: LlmConfig = { apiKey: "test", baseUrl: "http://x", model: "fake" };

/** Deterministic stand-in for the LLM: extraction by regex over our real invoice formats, judgement by simple rules. */
async function fakeChat(_cfg: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const sys = messages[0].content;
  const user = messages[1].content;
  if (sys.startsWith("You are an accounts-payable clerk")) {
    const openai = user.includes("OpenAI OpCo");
    const webshare = user.includes("Webshare");
    const proxy = user.includes("proxy-cheap");
    const inv = user.match(/Invoice number ([A-Z0-9-]+)|INVOICE #:\s+#([A-Z0-9-]+)|Invoice (PC-\d+)/);
    const invoiceId = inv?.[1] ?? inv?.[2] ?? inv?.[3] ?? "UNKNOWN";
    const dateStr = user.match(/Date of issue\s+([A-Za-z]+ \d+, \d{4})|DATE:\s+(\d{4}-\d{2}-\d{2})|Invoice PC-\d+\n([A-Za-z]+ \d+, \d{4})/);
    const raw = dateStr?.[1] ?? dateStr?.[2] ?? dateStr?.[3] ?? "2026-01-01";
    const issueDate = /^\d{4}-/.test(raw) ? raw : new Date(raw + " UTC").toISOString().slice(0, 10);
    let currency = "USD", amountGross = 0, amountDue = 0, alreadyPaid = false, vendorName = "?", description = "?";
    if (openai) {
      vendorName = "OpenAI OpCo, LLC";
      currency = "IDR";
      amountGross = amountDue = Number(user.match(/Amount due\s+Rp([\d,]+)/)![1].replace(/,/g, ""));
      description = user.includes("Plus") ? "ChatGPT Plus Subscription" : "ChatGPT Go Subscription";
    } else if (webshare) {
      vendorName = "Webshare Software";
      amountGross = 7.06;
      amountDue = 0;
      alreadyPaid = true;
      description = "100 Proxy Server with 250 GB";
    } else if (proxy) {
      vendorName = "Lietparkas, UAB (proxy-cheap.com)";
      amountGross = amountDue = Number(user.match(/Total \$([\d.]+)/)![1]);
      description = "Traffic routing #620759";
    }
    return JSON.stringify({ vendorName, invoiceId, issueDate, dueDate: issueDate, currency, amountDue, amountGross, alreadyPaid, description, servicePeriod: null });
  }
  // judge
  const { invoice } = JSON.parse(user);
  if (invoice.alreadyPaid || invoice.amountDue === 0) return JSON.stringify({ action: "skip", payOn: null, reasoning: "Invoice shows credits applied and total 0; nothing to pay.", anomalies: [], confidence: 0.95 });
  return JSON.stringify({ action: "pay_now", payOn: null, reasoning: "Genuine recurring invoice from a known vendor; due date has passed, amount consistent with history.", anomalies: [], confidence: 0.9 });
}

const fakeFetch = (async () => ({ json: async () => ({ result: "success", time_last_update_utc: "test", rates: { IDR: 18000, EUR: 0.9 } }) })) as unknown as typeof fetch;

function setup(balanceUsdc?: number, dry = false): ApOptions & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "ap-"));
  const invoicesDir = join(root, "invoices");
  const src = join(__dirname, "..", "data", "invoices");
  mkdtempSync(join(root, "x"));
  require("node:fs").mkdirSync(invoicesDir, { recursive: true });
  for (const f of readdirSync(src)) writeFileSync(join(invoicesDir, f), readFileSync(join(src, f)));
  return { root, invoicesDir, outDir: join(root, "ap"), queueDir: join(root, "queue"), policy: POLICY, cfg: CFG, today: "2026-10-01", dry, balanceUsdc, chatFn: fakeChat, fetchFn: fakeFetch };
}

describe("AP agent on the real invoice set", () => {
  it("skips the paid one, converts IDR, pays oldest-first within balance, defers the rest", async () => {
    const o = setup(18.5);
    const recs = await runAp(o);
    expect(recs).toHaveLength(6);
    const by = Object.fromEntries(recs.map((r) => [r.file, r]));

    expect(by["webshare-INV-3230164.txt"].judgement.action).toBe("skip");
    expect(by["webshare-INV-3230164.txt"].queued).toBe(false);

    // oldest invoices first: proxy-cheap Jun 17 (5.04) + Jul 16 (10.08) fit in 18.5 → 3.38 left
    expect(by["proxycheap-PC-625451.txt"].queued).toBe(true);
    expect(by["proxycheap-PC-652071.txt"].queued).toBe(true);
    // OpenAI Plus: 349000 IDR / 18000 = 19.39 USDC → deferred; Go: 4.17 each → also deferred (3.38 left)
    expect(by["openai-3XLNQNBZ-0001.txt"].usdc).toBe(19.39);
    expect(by["openai-3XLNQNBZ-0001.txt"].skippedBecause).toMatch(/insufficient/);
    expect(by["openai-3XLNQNBZ-0002.txt"].usdc).toBe(4.17);
    expect(by["openai-3XLNQNBZ-0002.txt"].queued).toBe(false);

    const q = readdirSync(o.queueDir).sort();
    expect(q).toHaveLength(2);
    expect(q[0]).toMatch(/^inv-proxy-cheap-PC625451-[0-9a-f]{8}\.json$/);
    expect(q[1]).toMatch(/^inv-proxy-cheap-PC652071-[0-9a-f]{8}\.json$/);
  });

  it("with enough balance everything payable is queued with FX recorded in the reason", async () => {
    const o = setup(60);
    const recs = await runAp(o);
    expect(recs.filter((r) => r.queued)).toHaveLength(5);
    const file = readdirSync(o.queueDir).find((f) => f.startsWith("inv-openai-3XLNQNBZ0003-"))!;
    const intent = JSON.parse(readFileSync(join(o.queueDir, file), "utf8"));
    expect(intent).toMatchObject({ vendorId: "openai", amount: 4.17, currency: "USDC", invoiceId: "3XLNQNBZ-0003" });
    expect(intent.reason).toMatch(/IDR 75000 @ 18000/);
    expect(existsSync(join(o.outDir, "openai-3XLNQNBZ-0003.json"))).toBe(true);
  });

  it("--dry writes decisions but never intents", async () => {
    const o = setup(undefined, true);
    await runAp(o);
    expect(existsSync(o.queueDir)).toBe(false);
    expect(readdirSync(o.outDir)).toHaveLength(6);
  });

  it("vendor matching is by registry id/name, not by the LLM", () => {
    expect(matchVendor(POLICY, "OpenAI OpCo, LLC")).toBe("openai");
    expect(matchVendor(POLICY, "Lietparkas, UAB (proxy-cheap.com)")).toBe("proxy-cheap");
    expect(matchVendor(POLICY, "Webshare Software")).toBe("webshare");
    expect(matchVendor(POLICY, "Totally Legit Supplier")).toBeUndefined();
  });

  it("fx falls back to the static table when the API is down", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const fx = await fxUsdPer("IDR", down);
    expect(fx.source).toMatch(/fallback/);
    expect(fx.rate).toBeGreaterThan(10000);
    await expect(fxUsdPer("XXX", down)).rejects.toThrow(/no FX rate/);
  });
});

describe("AP agent — second review", () => {
  it("vendor matching is whole-token: no 'pen'→openai or 'ion'→notion", () => {
    expect(matchVendor(POLICY, "Pen")).toBeUndefined();
    expect(matchVendor(POLICY, "ION")).toBeUndefined();
    expect(matchVendor(POLICY, "Open AI Labs Scam Ltd")).toBeUndefined();
    expect(matchVendor(POLICY, "OpenAI OpCo, LLC")).toBe("openai");
  });
});
