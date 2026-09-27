import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "./policy.js";
import type { Decision, ExecutionResult, PaymentIntent } from "./types.js";

/**
 * Append-only, hash-chained JSONL ledger.
 *
 * Every entry commits to the previous entry's hash, so a reviewer can replay
 * exactly what the agent saw, what rule fired, and what went on chain — and
 * detect if any line was edited or removed. This is the "continuous euthyna".
 */

export type LedgerEntry =
  | { seq: number; ts: string; kind: "decision"; intent: PaymentIntent; decision: Decision; prevHash: string; hash: string }
  | { seq: number; ts: string; kind: "execution"; result: ExecutionResult; prevHash: string; hash: string }
  | { seq: number; ts: string; kind: "approval"; intentId: string; approvalToken: string; approver: string; bind: string; note?: string; prevHash: string; hash: string };

export type NewEntry =
  | { kind: "decision"; intent: PaymentIntent; decision: Decision }
  | { kind: "execution"; result: ExecutionResult }
  | { kind: "approval"; intentId: string; approvalToken: string; approver: string; bind: string; note?: string };

export const GENESIS_HASH = "0".repeat(64);

export function entryHash(prevHash: string, body: Omit<LedgerEntry, "hash">): string {
  return sha256(prevHash + "\n" + canonicalJson(body));
}

export class Ledger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
      this.entries = lines.map((l) => JSON.parse(l) as LedgerEntry);
    }
  }

  static inMemory(): Ledger {
    return new Ledger("");
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  get length(): number {
    return this.entries.length;
  }

  get headHash(): string {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS_HASH;
  }

  append(e: NewEntry, now: Date = new Date()): LedgerEntry {
    const seq = this.entries.length + 1;
    const prevHash = this.headHash;
    const body = { seq, ts: now.toISOString(), ...e, prevHash } as Omit<LedgerEntry, "hash">;
    const hash = entryHash(prevHash, body);
    const full = { ...body, hash } as LedgerEntry;
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(full) + "\n");
    }
    this.entries.push(full);
    return full;
  }

  /** Recompute the chain. Returns the first broken seq, or null if intact. */
  verify(): { ok: true } | { ok: false; brokenAtSeq: number; reason: string } {
    let prev = GENESIS_HASH;
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (body.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: "prevHash mismatch" };
      const expect = entryHash(prev, body);
      if (expect !== hash) return { ok: false, brokenAtSeq: e.seq, reason: "hash mismatch (entry edited?)" };
      prev = hash;
    }
    return { ok: true };
  }

  /* ---- queries the engine needs ---- */

  executions(): ExecutionResult[] {
    return this.entries.filter((e): e is Extract<LedgerEntry, { kind: "execution" }> => e.kind === "execution").map((e) => e.result);
  }

  successfulExecutionFor(intentId: string): ExecutionResult | undefined {
    return this.executions().find((r) => r.intentId === intentId && r.ok);
  }

  decisionFor(intentId: string): Extract<LedgerEntry, { kind: "decision" }> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === "decision" && e.intent.intentId === intentId) return e;
    }
    return undefined;
  }

  approvalFor(intentId: string, token: string, bind: string): boolean {
    return this.entries.some((e) => e.kind === "approval" && e.intentId === intentId && e.approvalToken === token && e.bind === bind);
  }

  /** Most recent decision for this intent whose verdict was "hold" (later denies from bad tokens don't erase it). */
  latestHoldDecision(intentId: string): Extract<LedgerEntry, { kind: "decision" }> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === "decision" && e.intent.intentId === intentId && e.decision.verdict === "hold") return e;
    }
    return undefined;
  }

  /** Successful payments joined with the decision that authorized them. */
  settledPayments(): Array<{ decision: Decision; intent: PaymentIntent; result: ExecutionResult }> {
    const out: Array<{ decision: Decision; intent: PaymentIntent; result: ExecutionResult }> = [];
    for (const r of this.executions()) {
      if (!r.ok) continue;
      const d = this.decisionFor(r.intentId);
      if (d) out.push({ decision: d.decision, intent: d.intent, result: r });
    }
    return out;
  }
}
