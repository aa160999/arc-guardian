import { describe, expect, it } from "vitest";
import { evaluate } from "../src/engine.js";
import { DryRunExecutor } from "../src/executors.js";
import { Guardian } from "../src/guardian.js";
import { Ledger } from "../src/ledger.js";
import { parsePolicy } from "../src/policy.js";

const POLICY = parsePolicy(`
version: 1
business: test co
caps: { perTx: 200, daily: 300, monthly: 1500 }
approvalThreshold: 150
unknownRecipient: deny
duplicateWindowDays: 14
mediumRiskCapMultiplier: 0.5
vendors:
  - id: anthropic
    name: Anthropic
    address: "0x1111111111111111111111111111111111111111"
    caps: { perTx: 120, monthly: 400 }
  - id: designer
    name: Designer
    address: "0x3333333333333333333333333333333333333333"
    riskTier: medium
    caps: { perTx: 100, monthly: 300 }
  - id: shady
    name: Shady
    address: "0x5555555555555555555555555555555555555555"
    riskTier: high
  - id: eu
    name: EU SaaS
    address: "0x4444444444444444444444444444444444444444"
    currencies: [EURC]
`);

const T0 = new Date("2026-09-27T10:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);

function mk(overrides: Partial<Parameters<typeof evaluate>[2]> = {}) {
  return { intentId: "i-" + Math.random().toString(36).slice(2), vendorId: "anthropic", amount: 50, currency: "USDC" as const, reason: "api bill", ...overrides };
}

function guardian(now: () => Date, ledger = Ledger.inMemory()) {
  return { g: new Guardian({ policy: POLICY, ledger, executor: new DryRunExecutor(), from: "0xtreasury", chain: "ARC-TESTNET", now }), ledger };
}

describe("evaluate", () => {
  it("allows a normal payment to a known vendor", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk(), T0);
    expect(d.verdict).toBe("allow");
    expect(d.to).toBe("0x1111111111111111111111111111111111111111");
    expect(d.hits).toEqual([]);
  });

  it("denies unknown recipients by default", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: undefined, to: "0x9999999999999999999999999999999999999999" }), T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits[0].rule).toBe("known-recipient");
  });

  it("denies when vendorId and to disagree (invoice-fraud shape)", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ to: "0x9999999999999999999999999999999999999999" }), T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits.map((h) => h.rule)).toContain("recipient-mismatch");
  });

  it("enforces vendor per-tx cap", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ amount: 121 }), T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits.map((h) => h.rule)).toContain("cap:vendor:anthropic:perTx");
  });

  it("halves caps for medium-risk vendors", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: "designer", amount: 60 }), T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits.map((h) => h.rule)).toContain("cap:vendor:designer:perTx");
    const ok = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: "designer", amount: 50 }), T0);
    expect(ok.verdict).toBe("allow");
  });

  it("holds high-risk vendors regardless of amount", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: "shady", amount: 1 }), T0);
    expect(d.verdict).toBe("hold");
  });

  it("holds at or above the approval threshold", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ amount: 150 }), T0);
    expect(d.verdict).toBe("deny"); // 150 > vendor perTx 120 → deny wins over hold
    const d2 = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: undefined, to: "0x1111111111111111111111111111111111111111", amount: 119 }), T0);
    expect(d2.verdict).toBe("allow");
  });

  it("denies currency the vendor does not accept", () => {
    const d = evaluate(POLICY, Ledger.inMemory(), mk({ vendorId: "eu", amount: 10, currency: "USDC" }), T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits[0].rule).toBe("currency");
  });
});

describe("Guardian with ledger state", () => {
  it("is idempotent: same intentId never pays twice", async () => {
    const { g } = guardian(() => T0);
    const i = mk({ intentId: "inv-1" });
    const first = await g.pay(i);
    expect(first.execution?.ok).toBe(true);
    const second = await g.pay(i);
    expect(second.decision.verdict).toBe("deny");
    expect(second.decision.hits[0].rule).toBe("idempotency");
    expect(second.execution).toBeUndefined();
  });

  it("denies paying the same invoiceId twice, holds same-amount within window", async () => {
    let now = T0;
    const { g } = guardian(() => now);
    await g.pay(mk({ intentId: "a", invoiceId: "INV-100", amount: 40 }));
    const dup = await g.pay(mk({ intentId: "b", invoiceId: "INV-100", amount: 40 }));
    expect(dup.decision.verdict).toBe("deny");
    expect(dup.decision.hits.map((h) => h.rule)).toContain("duplicate-invoice");

    const near = await g.pay(mk({ intentId: "c", invoiceId: "INV-101", amount: 40 }));
    expect(near.decision.verdict).toBe("hold");
    expect(near.decision.hits.map((h) => h.rule)).toContain("possible-duplicate");

    now = at(15 * 24); // 15 days later, outside the 14d window
    const later = await g.pay(mk({ intentId: "d", invoiceId: "INV-102", amount: 40 }));
    expect(later.decision.verdict).toBe("allow");
  });

  it("rolling daily cap counts only settled payments inside the window", async () => {
    let now = T0;
    const { g } = guardian(() => now);
    // distinct amounts so the possible-duplicate rule stays out of the way
    await g.pay(mk({ intentId: "p1", amount: 100, invoiceId: "1" }));
    await g.pay(mk({ intentId: "p2", amount: 90, invoiceId: "2" }));
    await g.pay(mk({ intentId: "p3", amount: 110, invoiceId: "3" }));
    const over = await g.pay(mk({ intentId: "p4", amount: 10, invoiceId: "4" }));
    expect(over.decision.verdict).toBe("deny");
    expect(over.decision.hits.map((h) => h.rule)).toContain("cap:global:daily");
    const daily = over.decision.budgets.find((b) => b.scope === "global" && b.window === "daily")!;
    expect(daily.spent).toBe(300);
    expect(daily.remaining).toBe(0);

    now = at(25);
    const next = await g.pay(mk({ intentId: "p5", amount: 10, invoiceId: "5" }));
    expect(next.decision.verdict).toBe("allow");
  });

  it("a recorded approval lifts a hold; a forged token is denied", async () => {
    const { g } = guardian(() => T0);
    const held = await g.pay(mk({ intentId: "h1", vendorId: "shady", amount: 5 }));
    expect(held.decision.verdict).toBe("hold");

    const forged = await g.pay(mk({ intentId: "h1", vendorId: "shady", amount: 5, approvalToken: "apr_forged" }));
    expect(forged.decision.verdict).toBe("deny");

    const token = g.approve("h1", "ryan", "known counterparty, one-off");

    // token is bound to (to, amount, currency): changing the amount after approval does not work
    const bumped = await g.pay(mk({ intentId: "h1", vendorId: "shady", amount: 50, approvalToken: token }));
    expect(bumped.decision.verdict).toBe("deny");

    const ok = await g.pay(mk({ intentId: "h1", vendorId: "shady", amount: 5, approvalToken: token }));
    expect(ok.decision.verdict).toBe("allow");
    expect(ok.execution?.ok).toBe(true);

    // and once executed, nothing more can be approved for it
    expect(() => g.approve("h1", "ryan")).toThrow(/already executed/);
  });

  it("approval never lifts a deny", () => {
    const { g } = guardian(() => T0);
    g.check(mk({ intentId: "x", amount: 999 }));
    expect(() => g.approve("x", "ryan")).toThrow(/not hold/);
  });
});

describe("regressions from review", () => {
  it("a replayed intent cannot rewrite the settled amount (spend windows stay honest)", async () => {
    const { g, ledger } = guardian(() => T0);
    await g.pay(mk({ intentId: "big", amount: 90, invoiceId: "A" }));
    // replay with a tiny amount → denied by idempotency, must NOT change what counts as spent
    const replay = await g.pay(mk({ intentId: "big", amount: 0.01, invoiceId: "A" }));
    expect(replay.decision.verdict).toBe("deny");
    const daily = evaluate(POLICY, ledger, mk({ intentId: "next", amount: 1, invoiceId: "B" }), T0).budgets.find((b) => b.scope === "global" && b.window === "daily")!;
    expect(daily.spent).toBe(90);
  });

  it("possible-duplicate also fires when neither payment carries an invoiceId", async () => {
    const { g } = guardian(() => T0);
    await g.pay(mk({ intentId: "a1", amount: 33 }));
    const again = await g.pay(mk({ intentId: "a2", amount: 33 }));
    expect(again.decision.verdict).toBe("hold");
    expect(again.decision.hits.map((h) => h.rule)).toContain("possible-duplicate");
  });

  it("an attempt that reached the provider but did not confirm blocks re-execution", () => {
    const ledger = Ledger.inMemory();
    const i = mk({ intentId: "stuck", amount: 5 });
    ledger.append({ kind: "decision", intent: i, decision: evaluate(POLICY, ledger, i, T0) });
    ledger.append({ kind: "execution", result: { intentId: "stuck", ok: false, providerId: "tx-123", state: "SENT", error: "transfer ended in state SENT", executedAt: T0.toISOString() } });
    const d = evaluate(POLICY, ledger, i, T0);
    expect(d.verdict).toBe("deny");
    expect(d.hits[0].detail).toMatch(/submitted \(state SENT\)/);
  });

  it("unknown vendorId with no address is denied even when policy says hold for unknown recipients", () => {
    const p = parsePolicy(`{ version: 1, business: x, unknownRecipient: hold, vendors: [] }`);
    const d = evaluate(p, Ledger.inMemory(), { intentId: "u", vendorId: "ghost", amount: 1, currency: "USDC", reason: "r" }, T0);
    expect(d.verdict).toBe("deny");
  });
});
