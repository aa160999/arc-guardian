import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Decision, ExecutionResult } from "./types.js";

const execFileP = promisify(execFile);

export interface ExecuteOpts {
  from: string;
  chain: string;
  /** Guardian's clock. Executors stamp executedAt with this, never with wall time, so replays are deterministic. */
  now: Date;
}

export interface Executor {
  readonly name: string;
  /** Only ever called with a Decision whose verdict is "allow". */
  execute(decision: Decision, opts: ExecuteOpts): Promise<ExecutionResult>;
}

/** Records what WOULD have happened. Used in tests and `guardian check`. */
export class DryRunExecutor implements Executor {
  readonly name = "dry-run";
  async execute(d: Decision, opts: ExecuteOpts): Promise<ExecutionResult> {
    return {
      intentId: d.intentId,
      ok: true,
      txHash: "0x" + "d".repeat(64),
      state: "dry-run",
      executedAt: opts.now.toISOString(),
    };
  }
}

/**
 * Shape of `circle wallet transfer ... --output json`, as observed on Arc
 * testnet 2026-09-27 (Circle CLI, tx 0x0f13e2…c216). The CLI blocks until the
 * transfer is COMPLETE (~5–10 s), so `txHash` is present on success.
 */
export interface CircleTransferResponse {
  data: {
    id: string;
    idempotencyKey?: string;
    state: "INITIATED" | "QUEUED" | "SENT" | "CONFIRMED" | "COMPLETE" | "FAILED" | "CANCELLED" | "DENIED" | string;
    blockchain: string;
    txHash?: string;
    sourceAddress: string;
    destinationAddress: string;
    amounts: string[];
    networkFee?: string;
    operation: "TRANSFER" | string;
    transactionType: "OUTBOUND" | "INBOUND";
    blockHash?: string;
    blockHeight?: number;
    firstConfirmDate?: string;
    createDate: string;
    updateDate: string;
  };
}

export const EXPLORER: Record<string, string> = {
  "ARC-TESTNET": "https://explorer.testnet.arc.io",
  ARC: "https://explorer.arc.io",
};

export function explorerTxUrl(chain: string, txHash: string): string | undefined {
  const base = EXPLORER[chain];
  return base ? `${base}/tx/${txHash}` : undefined;
}

/**
 * Pays through the Circle Agent Wallet by shelling out to the official CLI:
 *   circle wallet transfer <to> --amount <amt> --address <from> --chain <chain> --output json
 *
 * Why the CLI and not an SDK: agent-wallet sessions live in the OS keychain
 * after `circle wallet login` (email OTP). The CLI is the supported way for an
 * agent to use that session without ever seeing key material.
 */
export class CircleCliExecutor implements Executor {
  readonly name = "circle-cli";
  constructor(private readonly bin: string = "circle") {}

  async execute(d: Decision, opts: ExecuteOpts): Promise<ExecutionResult> {
    if (d.verdict !== "allow") throw new Error("refusing to execute a non-allow decision");
    if (!d.to) throw new Error("decision has no recipient");
    const args = ["wallet", "transfer", d.to, "--amount", String(d.amount), "--address", opts.from, "--chain", opts.chain, "--output", "json"];
    if (d.currency !== "USDC") {
      // --token wants a contract address; resolve via `circle contract address` before enabling EURC here.
      throw new Error(`currency ${d.currency} not wired for CLI executor yet (needs --token <contract>)`);
    }
    const executedAt = opts.now.toISOString();
    try {
      const { stdout } = await execFileP(this.bin, args, { env: { ...process.env, CIRCLE_ACCEPT_TERMS: "1" }, maxBuffer: 1 << 20 });
      const raw = safeJson(stdout);
      const data = (raw as Partial<CircleTransferResponse>)?.data;
      if (!data || typeof data !== "object" || typeof data.id !== "string") {
        return { intentId: d.intentId, ok: false, error: "unexpected circle cli output (no data.id)", raw, executedAt };
      }
      const terminalOk = data.state === "COMPLETE" || data.state === "CONFIRMED";
      return {
        intentId: d.intentId,
        ok: terminalOk,
        txHash: data.txHash,
        providerId: data.id,
        state: data.state,
        networkFee: data.networkFee,
        confirmedAt: data.firstConfirmDate,
        explorerUrl: data.txHash ? explorerTxUrl(opts.chain, data.txHash) : undefined,
        error: terminalOk ? undefined : `transfer ended in state ${data.state}`,
        raw,
        executedAt,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        intentId: d.intentId,
        ok: false,
        error: (e.stderr || e.message || "circle cli failed").trim(),
        raw: e.stdout ? safeJson(e.stdout) : undefined,
        executedAt,
      };
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _unparsed: s };
  }
}
