import { randomBytes } from "node:crypto";
import { approvalBinding, evaluate } from "./engine.js";
import type { Executor } from "./executors.js";
import { Ledger } from "./ledger.js";
import { PaymentIntent, type Decision, type ExecutionResult, type Policy } from "./types.js";

export interface GuardianOptions {
  policy: Policy;
  ledger: Ledger;
  executor: Executor;
  /** Treasury agent-wallet address payments are sent from. */
  from: string;
  /** e.g. "ARC-TESTNET" | "ARC" */
  chain: string;
  now?: () => Date;
}

export interface PayOutcome {
  decision: Decision;
  execution?: ExecutionResult;
}

/**
 * The one door money leaves through.
 *
 *   agent  --intent-->  Guardian.pay()  --allow-->  executor  --> chain
 *                            |-- hold --> ledger (awaits approve())
 *                            |-- deny --> ledger
 */
export class Guardian {
  constructor(private readonly o: GuardianOptions) {}

  /** Evaluate only. Writes the decision to the ledger, moves no money. */
  check(rawIntent: unknown): Decision {
    const intent = PaymentIntent.parse(rawIntent);
    const now = this.o.now?.() ?? new Date();
    this.o.ledger.reloadIfChanged();
    const decision = evaluate(this.o.policy, this.o.ledger, intent, now);
    this.o.ledger.append({ kind: "decision", intent, decision }, now);
    return decision;
  }

  /** Evaluate, and if allowed, execute. Everything is written to the ledger in order. */
  async pay(rawIntent: unknown): Promise<PayOutcome> {
    const decision = this.check(rawIntent);
    if (decision.verdict !== "allow") return { decision };
    const now = this.o.now?.() ?? new Date();
    const execution = await this.o.executor.execute(decision, { from: this.o.from, chain: this.o.chain, now });
    this.o.ledger.append({ kind: "execution", result: execution }, now);
    return { decision, execution };
  }

  /**
   * A human lifts a HOLD. Returns the token the agent must attach as `intent.approvalToken`
   * when it re-submits the same intentId. The approval is recorded in the ledger and bound to
   * (recipient, amount, currency, the exact hold rules present at approval time): if a new hold
   * appears later — say a possible-duplicate — the token no longer applies. Once the intent
   * executes, idempotency stops any further use.
   */
  approve(intentId: string, approver: string, note?: string): string {
    if (this.o.ledger.successfulExecutionFor(intentId)) throw new Error(`intent ${intentId} already executed; nothing to approve`);
    const held = this.o.ledger.latestHoldDecision(intentId);
    if (!held) {
      const last = this.o.ledger.decisionFor(intentId);
      throw new Error(last ? `intent ${intentId} is ${last.decision.verdict}, not hold; nothing to approve` : `no decision on record for intent ${intentId}`);
    }
    const bind = approvalBinding(held.decision);
    const approvalToken = "apr_" + randomBytes(9).toString("base64url");
    this.o.ledger.append({ kind: "approval", intentId, approvalToken, approver, bind, note }, this.o.now?.() ?? new Date());
    return approvalToken;
  }
}
