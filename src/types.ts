import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Policy: what the business allows the agent to do, as data.          */
/* Deterministic. The LLM never sees or edits this at runtime.         */
/* ------------------------------------------------------------------ */

export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

export const Currency = z.enum(["USDC", "EURC"]);
export type Currency = z.infer<typeof Currency>;

export const RiskTier = z.enum(["low", "medium", "high"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const WindowCaps = z
  .object({
    perTx: z.number().positive().optional(),
    daily: z.number().positive().optional(),
    weekly: z.number().positive().optional(),
    monthly: z.number().positive().optional(),
  })
  .strict();
export type WindowCaps = z.infer<typeof WindowCaps>;

export const Vendor = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    address: EvmAddress,
    riskTier: RiskTier.default("low"),
    currencies: z.array(Currency).min(1).default(["USDC"]),
    caps: WindowCaps.default({}),
    /** Free-text the human wrote about this vendor; surfaced in decisions. */
    notes: z.string().optional(),
  })
  .strict();
export type Vendor = z.infer<typeof Vendor>;

export const Policy = z
  .object({
    version: z.literal(1),
    /** Human-readable owner of this policy, e.g. "Ryan's dev shop". */
    business: z.string().min(1),
    /** Global caps across all vendors. */
    caps: WindowCaps.default({}),
    /** Amount at or above which a human must approve before payment. */
    approvalThreshold: z.number().positive().optional(),
    /** What to do with a recipient that is not in `vendors`. */
    unknownRecipient: z.enum(["deny", "hold"]).default("deny"),
    /** Same vendor + same amount within this many days → possible duplicate → hold. */
    duplicateWindowDays: z.number().int().nonnegative().default(14),
    /** Medium-risk vendors get their caps multiplied by this (e.g. 0.5). */
    mediumRiskCapMultiplier: z.number().positive().max(1).default(0.5),
    vendors: z.array(Vendor).default([]),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

/* ------------------------------------------------------------------ */
/* Intent: what the agent WANTS to do. Produced by the LLM/agent.      */
/* ------------------------------------------------------------------ */

export const PaymentIntent = z
  .object({
    /** Idempotency key. Same intentId can never execute twice. */
    intentId: z.string().min(1),
    /** Vendor id from policy, or omit and give `to` for ad-hoc recipients. */
    vendorId: z.string().optional(),
    to: EvmAddress.optional(),
    amount: z.number().positive(),
    currency: Currency.default("USDC"),
    /** Invoice / bill identifier as printed by the vendor. Drives exact-dup detection. */
    invoiceId: z.string().optional(),
    /** Why the agent wants to pay. Goes verbatim into the ledger. */
    reason: z.string().min(1),
    /** Optional human approval token for intents that were previously HELD. */
    approvalToken: z.string().optional(),
    /** Anything else the agent saw (due date, extracted fields, source doc hash). */
    context: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((i) => i.vendorId || i.to, {
    message: "intent needs vendorId or to",
  });
export type PaymentIntent = z.infer<typeof PaymentIntent>;

/* ------------------------------------------------------------------ */
/* Decision: what Guardian says. Pure output of evaluate().            */
/* ------------------------------------------------------------------ */

export type Verdict = "allow" | "hold" | "deny";

export interface RuleHit {
  rule: string;
  verdict: Verdict;
  detail: string;
}

export interface BudgetSnapshot {
  scope: "global" | `vendor:${string}`;
  window: "perTx" | "daily" | "weekly" | "monthly";
  cap: number;
  spent: number;
  remaining: number;
}

export interface Decision {
  intentId: string;
  verdict: Verdict;
  /** Resolved recipient address (from vendor or intent.to). */
  to?: string;
  vendorId?: string;
  amount: number;
  currency: Currency;
  hits: RuleHit[];
  budgets: BudgetSnapshot[];
  /** Hash of the policy that produced this decision, for replay. */
  policyHash: string;
  evaluatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Execution: what actually happened on chain.                          */
/* ------------------------------------------------------------------ */

export interface ExecutionResult {
  intentId: string;
  ok: boolean;
  txHash?: string;
  /** Provider-side id (Circle transaction id) if any. */
  providerId?: string;
  state?: string;
  /** Gas paid, in USDC (Arc's native gas token). */
  networkFee?: string;
  confirmedAt?: string;
  explorerUrl?: string;
  error?: string;
  /** Raw provider output, kept for audit; never parsed for policy. */
  raw?: unknown;
  executedAt: string;
}
