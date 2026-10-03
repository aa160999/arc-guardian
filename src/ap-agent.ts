/**
 * Reference AP (accounts-payable) agent.
 *
 *   data/invoices/*.txt  ─▶ LLM extract ─▶ LLM decide (pay / schedule / skip / hold + why)
 *                          ─▶ FX to USDC ─▶ balance check ─▶ PaymentIntent ─▶ data/queue/  (Guardian pays)
 *                          ─▶ data/ap/<invoice>.json   (everything the agent saw and concluded)
 *
 * Division of labour, on purpose:
 *   - The LLM reads messy documents and explains itself. It never touches money.
 *   - Guardian (deterministic) decides whether money may move. The LLM cannot override it.
 *
 * Usage: npm run ap            (writes intents to the queue)
 *        npm run ap -- --dry   (decisions only, no intents)
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadDotenv } from "./env.js";
import { chat, llmConfigFromEnv, type ChatMessage, type LlmConfig } from "./llm.js";
import { loadPolicy } from "./policy.js";
import type { Policy } from "./types.js";

const execFileP = promisify(execFile);

/* ---------- what the LLM must produce (validated; anything else is rejected) ---------- */

export const Extracted = z.object({
  vendorName: z.string().min(1),
  invoiceId: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  currency: z.string().min(3).max(3),
  /** Amount the vendor is asking for AFTER credits/discounts. 0 if fully paid. */
  amountDue: z.number().nonnegative(),
  /** Gross amount before credits, for the record. */
  amountGross: z.number().nonnegative(),
  alreadyPaid: z.boolean(),
  description: z.string().min(1),
  servicePeriod: z.string().nullable(),
});
export type Extracted = z.infer<typeof Extracted>;

export const Judgement = z.object({
  action: z.enum(["pay_now", "schedule", "skip", "hold"]),
  /** For schedule: the date to pay. */
  payOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  reasoning: z.string().min(10),
  anomalies: z.array(z.string()),
  /** 0–1: how sure the model is the invoice is genuine and consistent with history. */
  confidence: z.number().min(0).max(1),
});
export type Judgement = z.infer<typeof Judgement>;

export interface ApRecord {
  file: string;
  extracted: Extracted;
  judgement: Judgement;
  vendorId?: string;
  fx?: Fx;
  usdc?: number;
  payCurrency?: "USDC" | "EURC";
  balanceUsdc?: number;
  treasury?: TreasuryView;
  intentId?: string;
  queued: boolean;
  skippedBecause?: string;
  at: string;
}

/* ---------- prompts ---------- */

const EXTRACT_SYS = `You are an accounts-payable clerk. Extract fields from the invoice text as strict JSON with keys:
vendorName, invoiceId, issueDate (YYYY-MM-DD), dueDate (YYYY-MM-DD or null), currency (ISO 4217, e.g. USD, IDR, EUR; "Rp" means IDR),
amountDue (number, AFTER credits applied; 0 if the invoice says it is paid or total is 0), amountGross (number, before credits),
alreadyPaid (boolean: true if the document states it is paid or amount due is 0), description (one line), servicePeriod (string or null).
Output JSON only.`;

const JUDGE_SYS = `You are the finance agent of a small solo software business. Today is {TODAY}.
You are given one extracted invoice, the vendor's entry in the owner's registry (null if unknown; ownerNotes are the business owner's own remarks and are trustworthy context), the vendor's prior invoices we know about, and the treasury balance in USDC.
We pay in USDC on Arc; invoices in other currencies are converted at the day's rate, so a foreign currency is normal, not an anomaly. Being overdue is a reason to pay now, not to hold.
Decide ONE action:
- "pay_now": genuine, due (or overdue), amount consistent with history or explained by a plan change.
- "schedule": genuine but not yet due and no early-pay benefit; set payOn = dueDate.
- "skip": nothing to pay (already paid / zero due / credits covered it).
- "hold": something is off (amount jump without explanation, unknown vendor, mismatch, possible duplicate) → a human must look.
Explain in 2–4 sentences a reviewer can audit. List anomalies explicitly (empty list if none). Confidence 0–1.
You do NOT move money; a separate policy engine will re-check everything you say. Output JSON only with keys action, payOn, reasoning, anomalies, confidence.`;

/* ---------- helpers ---------- */

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

async function llmJson<T>(cfg: LlmConfig, schema: z.ZodType<T>, messages: ChatMessage[], chatFn = chat): Promise<T> {
  const out = await chatFn(cfg, messages, { json: true, temperature: 0 });
  const parsed = schema.safeParse(JSON.parse(stripFences(out)));
  if (!parsed.success) throw new Error("llm output failed validation: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

export type Fx = { rate: number; base: "USD"; quote: string; asOf: string; source: string };

export async function fxUsdPer(quote: string, fetchFn = fetch): Promise<Fx> {
  if (quote === "USD") return { rate: 1, base: "USD", quote, asOf: new Date().toISOString(), source: "identity" };
  try {
    const r = await fetchFn("https://open.er-api.com/v6/latest/USD");
    const d = (await r.json()) as { result: string; time_last_update_utc: string; rates: Record<string, number> };
    if (d.result === "success" && d.rates[quote]) return { rate: d.rates[quote], base: "USD", quote, asOf: d.time_last_update_utc, source: "open.er-api.com" };
  } catch {
    /* fall through */
  }
  const FALLBACK: Record<string, number> = { IDR: 17950, EUR: 0.88, JPY: 150 };
  if (!FALLBACK[quote]) throw new Error(`no FX rate for ${quote}`);
  return { rate: FALLBACK[quote], base: "USD", quote, asOf: "fallback", source: "static fallback table" };
}

/** Map an extracted vendor name onto the policy's vendor registry by name similarity (id or name substring). */
export function matchVendor(policy: Policy, vendorName: string): string | undefined {
  // Whole-token match only: "openai opco" matches alias "openai"; "pen" or "ion" match nothing.
  const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((t) => t.length >= 3);
  const n = new Set(tokens(vendorName));
  if (!n.size) return undefined;
  const hit = policy.vendors.find((v) => [v.id, v.name, ...v.aliases].some((k) => {
    const kt = tokens(k);
    return kt.length > 0 && kt.every((t) => n.has(t));
  }));
  return hit?.id;
}

export interface TreasuryView {
  walletUsdc: number;
  gatewayUsdc: number;
  /** what the agent may spend from the wallet right now */
  spendableUsdc: number;
}

/**
 * Treasury = agent wallet USDC on this chain + USDC parked in Circle Gateway (the unified,
 * chain-abstracted balance). Only the wallet part is spendable by `circle wallet transfer`;
 * Gateway is reported so the agent sees "what the company actually holds" before deciding.
 */
export async function treasuryView(env: NodeJS.ProcessEnv): Promise<TreasuryView | undefined> {
  const address = env.GUARDIAN_TREASURY_ADDRESS;
  const chain = env.GUARDIAN_CHAIN ?? "ARC-TESTNET";
  if (!address) return undefined;
  const cliEnv = { ...env, CIRCLE_ACCEPT_TERMS: "1" };
  let walletUsdc: number | undefined;
  try {
    const { stdout } = await execFileP("circle", ["wallet", "balance", "--address", address, "--chain", chain, "--output", "json"], { env: cliEnv });
    // shape seen 2026-10-01: { data: { balances: [{ amount, token: { symbol, isNative, ... } }] } }
    const j = JSON.parse(stdout) as { data?: { balances?: Array<{ amount: string; token?: { symbol?: string; isNative?: boolean } }> } };
    const rows = (j.data?.balances ?? []).filter((b) => (b.token?.symbol ?? "").toUpperCase() === "USDC");
    const pick = rows.find((b) => b.token?.isNative) ?? rows[0];
    walletUsdc = pick ? Number(pick.amount) : undefined;
  } catch {
    return undefined;
  }
  if (walletUsdc === undefined) return undefined;
  let gatewayUsdc = 0;
  try {
    const { stdout } = await execFileP("circle", ["gateway", "balance", "--address", address, "--chain", chain, "--output", "json"], { env: cliEnv });
    // shape seen 2026-10-01: { data: { total: "0", balances: [{ network, domain, balance }] } }
    const j = JSON.parse(stdout) as { data?: { total?: string } };
    gatewayUsdc = Number(j.data?.total ?? 0) || 0;
  } catch {
    /* gateway optional */
  }
  return { walletUsdc, gatewayUsdc, spendableUsdc: walletUsdc };
}

/* ---------- main pipeline ---------- */

export interface ApOptions {
  invoicesDir: string;
  outDir: string;
  queueDir: string;
  policy: Policy;
  cfg: LlmConfig;
  today: string;
  dry: boolean;
  balanceUsdc?: number;
  treasury?: TreasuryView;
  chatFn?: typeof chat;
  fetchFn?: typeof fetch;
}

export async function runAp(o: ApOptions): Promise<ApRecord[]> {
  mkdirSync(o.outDir, { recursive: true });
  if (!o.dry) mkdirSync(o.queueDir, { recursive: true });
  const files = readdirSync(o.invoicesDir).filter((f) => f.endsWith(".txt")).sort();
  const records: ApRecord[] = [];
  let remaining = o.balanceUsdc;

  // pass 1: extract everything so pass 2 can see vendor history
  const extracted: Array<{ file: string; ex: Extracted }> = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(o.invoicesDir, f), "utf8");
      const ex = await llmJson(o.cfg, Extracted, [{ role: "system", content: EXTRACT_SYS }, { role: "user", content: text }], o.chatFn);
      extracted.push({ file: f, ex });
    } catch (e) {
      console.error(`[ap] ${f}: extraction failed, skipping — ${e instanceof Error ? e.message : e}`);
    }
  }
  extracted.sort((a, b) => a.ex.issueDate.localeCompare(b.ex.issueDate));

  // pass 2: judge each with history, then convert + queue
  for (const { file, ex } of extracted) {
    const history = extracted.filter((h) => h.file !== file && h.ex.vendorName.toLowerCase() === ex.vendorName.toLowerCase() && h.ex.issueDate < ex.issueDate).map((h) => h.ex);
    const vendorId = matchVendor(o.policy, ex.vendorName);
    const vendor = o.policy.vendors.find((v) => v.id === vendorId);
    const judgement = await llmJson(
      o.cfg,
      Judgement,
      [
        { role: "system", content: JUDGE_SYS.replace("{TODAY}", o.today) },
        { role: "user", content: JSON.stringify(
            {
              invoice: ex,
              vendorRegistryEntry: vendor ? { id: vendor.id, name: vendor.name, riskTier: vendor.riskTier, currencies: vendor.currencies, ownerNotes: vendor.notes ?? null } : null,
              priorInvoicesFromVendor: history,
              treasuryBalanceUsdc: remaining ?? "unknown",
              treasuryGatewayUsdc: o.treasury?.gatewayUsdc ?? "unknown",
            },
            null,
            2,
          ) },
      ],
      o.chatFn,
    );

    const rec: ApRecord = { file, extracted: ex, judgement, vendorId, queued: false, at: new Date().toISOString() };

    if (judgement.action === "pay_now" && ex.alreadyPaid) {
      rec.skippedBecause = "LLM said pay_now but extraction says alreadyPaid; not queuing";
    } else if (judgement.action === "pay_now" && ex.amountDue > 0) {
      const fx = await fxUsdPer(ex.currency, o.fetchFn);
      const usdc = Math.round((ex.amountDue / fx.rate) * 100) / 100;
      // Vendors that accept EURC get paid in EURC at face value (swap happens in the executor); budget is still tracked in USDC.
      const payInEurc = ex.currency === "EUR" && !!vendor?.currencies.includes("EURC");
      const payCurrency: "USDC" | "EURC" = payInEurc ? "EURC" : "USDC";
      const payAmount = payInEurc ? Math.round(ex.amountDue * 100) / 100 : usdc;
      rec.fx = fx;
      rec.usdc = usdc;
      rec.payCurrency = payCurrency;
      rec.balanceUsdc = remaining;
      if (!vendorId) {
        rec.skippedBecause = "vendor not in policy registry; Guardian would deny — needs a human to add the vendor";
      } else if (payAmount < 0.01) {
        rec.skippedBecause = `amount rounds to ${payAmount}; nothing payable`;
      } else if (remaining !== undefined && usdc > remaining) {
        rec.skippedBecause = `insufficient treasury balance (${remaining} USDC < ${usdc} USDC); deferred`;
      } else if (!o.dry) {
        // readable prefix + short hash of (vendor, invoice) so "INV/1" and "INV_1" cannot collide into one file
        const idHash = createHash("sha256").update(`${vendorId}\u0000${ex.invoiceId}`).digest("hex").slice(0, 8);
        const intentId = `inv-${vendorId}-${ex.invoiceId.replace(/[^A-Za-z0-9]/g, "")}-${idHash}`;
        const intent = {
          intentId,
          vendorId,
          amount: payAmount,
          currency: payCurrency,
          invoiceId: ex.invoiceId,
          reason: `${ex.description} (${ex.currency} ${ex.amountDue}${payInEurc ? " paid as EURC via USDC→EURC swap" : ` @ ${fx.rate} ${fx.quote}/USD, ${fx.source}`}). ${judgement.reasoning}`,
          context: { file, issueDate: ex.issueDate, dueDate: ex.dueDate, confidence: judgement.confidence, anomalies: judgement.anomalies },
        };
        writeFileSync(join(o.queueDir, `${intentId}.json`), JSON.stringify(intent, null, 2) + "\n");
        rec.intentId = intentId;
        rec.queued = true;
        if (remaining !== undefined) remaining = Math.round((remaining - usdc) * 100) / 100;
      }
    }
    writeFileSync(join(o.outDir, `${basename(file, ".txt")}.json`), JSON.stringify(rec, null, 2) + "\n");
    records.push(rec);
    console.log(`[ap] ${file}: ${ex.vendorName} ${ex.currency} ${ex.amountDue} → ${judgement.action}${rec.usdc !== undefined ? ` ${rec.usdc} USDC` : ""}${rec.queued ? " (queued)" : rec.skippedBecause ? ` (${rec.skippedBecause})` : ""}`);
  }
  return records;
}

if (process.argv[1] && /ap-agent\.(ts|js)$/.test(process.argv[1])) {
  loadDotenv();
  const dry = process.argv.includes("--dry");
  const policy = loadPolicy(process.env.GUARDIAN_POLICY ?? "./policy.yaml");
  const treasury = await treasuryView(process.env); // read-only, fine in --dry too
  const balanceUsdc = treasury?.spendableUsdc;
  const records = await runAp({
    invoicesDir: "./data/invoices",
    outDir: "./data/ap",
    queueDir: "./data/queue",
    policy,
    cfg: llmConfigFromEnv(),
    today: new Date().toISOString().slice(0, 10),
    dry,
    balanceUsdc,
    treasury,
  });
  const n = (a: string) => records.filter((r) => r.judgement.action === a).length;
  console.log(JSON.stringify({ invoices: records.length, pay_now: n("pay_now"), schedule: n("schedule"), skip: n("skip"), hold: n("hold"), queued: records.filter((r) => r.queued).length, treasury }, null, 2));
  if (!existsSync("./data/ap")) process.exitCode = 1;
}
