import type { Ledger } from "./ledger.js";
import { canonicalJson, findVendor, policyHash, sha256 } from "./policy.js";
import type { BudgetSnapshot, Decision, PaymentIntent, Policy, RuleHit, Verdict, WindowCaps } from "./types.js";

/**
 * evaluate(policy, ledger, intent) → Decision
 *
 * Pure with respect to (policy, ledger contents, intent, now). No I/O, no LLM.
 * The agent can argue all it wants in `intent.reason`; nothing in here reads it.
 */

const WINDOW_MS: Record<Exclude<keyof WindowCaps, "perTx">, number> = {
  daily: 24 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
};

function worst(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { allow: 0, hold: 1, deny: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** What an approval is bound to: the money-moving facts and the exact holds it lifts — never the prose. */
export function approvalBinding(d: { to?: string; amount: number; currency: string; hits?: RuleHit[] }): string {
  const holds = (d.hits ?? []).filter((h) => h.verdict === "hold" && h.rule !== "approval").map((h) => h.rule).sort();
  return sha256(canonicalJson({ to: d.to?.toLowerCase(), amount: d.amount, currency: d.currency, holds }));
}

/** Invoice ids as printed by vendors vary ("#1234", "INV-1234", "inv 1234"); compare on the alphanumeric core. */
export function normalizeInvoiceId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const n = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.length ? n : undefined;
}

export function evaluate(policy: Policy, ledger: Ledger, intent: PaymentIntent, now: Date = new Date()): Decision {
  const hits: RuleHit[] = [];
  const budgets: BudgetSnapshot[] = [];
  const state: { verdict: Verdict } = { verdict: "allow" };
  const hit = (rule: string, v: Verdict, detail: string) => {
    hits.push({ rule, verdict: v, detail });
    state.verdict = worst(state.verdict, v);
  };

  /* 1. Idempotency: the same intentId never executes twice — not after success, and not after a failed
        or unknown attempt either (the CLI may have broadcast before it errored). A human reconciles and,
        if the money truly did not move, re-issues under a new intentId. */
  const prior = ledger.attemptFor(intent.intentId);
  if (prior) {
    const what = prior.ok ? "executed" : `attempted (state ${prior.state ?? "unknown"}${prior.error ? ": " + prior.error.slice(0, 80) : ""})`;
    hit("idempotency", "deny", `intent ${intent.intentId} already ${what}${prior.txHash || prior.providerId ? " (" + (prior.txHash ?? prior.providerId) + ")" : ""}`);
  }

  /* 2. Recipient must be a known vendor (or policy says hold for unknown). */
  const vendor = findVendor(policy, { vendorId: intent.vendorId, to: intent.to });
  const to = vendor?.address ?? intent.to;
  if (intent.vendorId && !vendor) {
    hit("known-recipient", "deny", `vendorId ${intent.vendorId} is not in the registry`);
  } else if (!to) {
    hit("known-recipient", "deny", "no vendorId and no address given");
  } else if (!vendor) {
    hit("known-recipient", policy.unknownRecipient, `recipient ${intent.to} is not in the vendor registry`);
  } else if (intent.to && intent.to.toLowerCase() !== vendor.address.toLowerCase()) {
    // Agent supplied both a vendorId and an address, and they disagree. Classic BEC/invoice-fraud shape.
    hit("recipient-mismatch", "deny", `intent.to ${intent.to} != registered address for vendor ${vendor.id} (${vendor.address})`);
  }

  /* 3. Currency allowed for this vendor. */
  if (vendor && !vendor.currencies.includes(intent.currency)) {
    hit("currency", "deny", `vendor ${vendor.id} may only be paid in ${vendor.currencies.join("/")}, got ${intent.currency}`);
  }

  /* 4. Risk tier: high always needs a human; medium shrinks caps. */
  let capMul = 1;
  if (vendor?.riskTier === "high") hit("risk-tier", "hold", `vendor ${vendor.id} is high risk; human approval required`);
  if (vendor?.riskTier === "medium") capMul = policy.mediumRiskCapMultiplier;

  /* 5. Duplicate detection against settled payments. */
  const settled = ledger.settledPayments();
  const invoiceKey = normalizeInvoiceId(intent.invoiceId);
  if (vendor && invoiceKey) {
    const exact = settled.find((p) => p.decision.vendorId === vendor.id && normalizeInvoiceId(p.intent.invoiceId) === invoiceKey);
    if (exact) hit("duplicate-invoice", "deny", `invoice ${intent.invoiceId} for ${vendor.id} already paid (intent ${exact.intent.intentId})`);
  }
  if (vendor && policy.duplicateWindowDays > 0) {
    const windowMs = policy.duplicateWindowDays * 24 * 3600 * 1000;
    const near = settled.find(
      (p) =>
        p.decision.vendorId === vendor.id &&
        p.decision.currency === intent.currency &&
        Math.abs(p.decision.amount - intent.amount) < 1e-9 &&
        now.getTime() - Date.parse(p.result.executedAt) <= windowMs &&
        (invoiceKey === undefined || normalizeInvoiceId(p.intent.invoiceId) !== invoiceKey),
    );
    if (near) hit("possible-duplicate", "hold", `same vendor + same amount (${intent.amount} ${intent.currency}) paid within ${policy.duplicateWindowDays}d (intent ${near.intent.intentId})`);
  }

  /* 6. Caps: per-tx and rolling windows, global and per vendor. */
  // Caps are per token: a USDC cap only counts USDC payments, an EURC vendor's cap only EURC.
  const spentIn = (scopeVendor: string | undefined, windowMs: number) =>
    settled
      .filter((p) => p.decision.currency === intent.currency)
      .filter((p) => (scopeVendor ? p.decision.vendorId === scopeVendor : true))
      .filter((p) => now.getTime() - Date.parse(p.result.executedAt) <= windowMs)
      .reduce((s, p) => s + p.decision.amount, 0);

  const checkCaps = (scope: BudgetSnapshot["scope"], caps: WindowCaps, scopeVendor: string | undefined, mul: number) => {
    if (caps.perTx !== undefined) {
      const cap = caps.perTx * mul;
      budgets.push({ scope, window: "perTx", cap, spent: 0, remaining: cap });
      if (intent.amount > cap) hit(`cap:${scope}:perTx`, "deny", `${intent.amount} exceeds per-tx cap ${cap}`);
    }
    for (const w of ["daily", "weekly", "monthly"] as const) {
      if (caps[w] === undefined) continue;
      const cap = caps[w]! * mul;
      const spent = spentIn(scopeVendor, WINDOW_MS[w]);
      const remaining = Math.max(0, cap - spent);
      budgets.push({ scope, window: w, cap, spent, remaining });
      if (spent + intent.amount > cap) hit(`cap:${scope}:${w}`, "deny", `${w} cap ${cap}: spent ${spent} + ${intent.amount} would exceed`);
    }
  };
  checkCaps("global", policy.caps, undefined, 1);
  if (vendor) checkCaps(`vendor:${vendor.id}`, vendor.caps, vendor.id, capMul);

  /* 7. Human approval threshold (or a previously held intent carrying its token). */
  if (policy.approvalThreshold !== undefined && intent.amount >= policy.approvalThreshold) {
    hit("approval-threshold", "hold", `${intent.amount} >= approval threshold ${policy.approvalThreshold}`);
  }

  /* 8. A valid approval token lifts HOLDs (never DENYs), and only for the exact (to, amount, currency) that was held. */
  if (state.verdict === "hold" && intent.approvalToken) {
    const bind = approvalBinding({ to, amount: intent.amount, currency: intent.currency, hits });
    if (ledger.approvalFor(intent.intentId, intent.approvalToken, bind)) {
      hits.push({ rule: "approval", verdict: "allow", detail: `hold lifted by recorded approval ${intent.approvalToken}` });
      state.verdict = "allow";
    } else {
      // A stale or wrong token does not lift anything; the intent simply stays on hold (so a human can
      // approve it afresh with every current hold visible). It is never upgraded to a deny.
      hit("approval", "hold", `approval token ${intent.approvalToken} does not match this intent's payment facts and current holds (${hits.filter((h) => h.verdict === "hold").map((h) => h.rule).join(",")}); still held`);
    }
  }

  return {
    intentId: intent.intentId,
    verdict: state.verdict,
    to,
    vendorId: vendor?.id,
    amount: intent.amount,
    currency: intent.currency,
    hits,
    budgets,
    policyHash: policyHash(policy),
    evaluatedAt: now.toISOString(),
  };
}
