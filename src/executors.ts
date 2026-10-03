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
/** Token contracts per chain (from `circle contract address`). USDC is native on Arc and needs no --token. */
export const TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  "ARC-TESTNET": { EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" },
};

export class CircleCliExecutor implements Executor {
  readonly name = "circle-cli";
  constructor(private readonly bin: string = "circle") {}

  private async run(args: string[]): Promise<{ raw: unknown; data: Record<string, unknown> | undefined }> {
    const { stdout } = await execFileP(this.bin, args, { env: { ...process.env, CIRCLE_ACCEPT_TERMS: "1" }, maxBuffer: 1 << 20, timeout: 180_000 });
    const raw = safeJson(stdout);
    const data = (raw as { data?: Record<string, unknown> })?.data;
    return { raw, data: data && typeof data === "object" ? data : undefined };
  }

  async execute(d: Decision, opts: ExecuteOpts): Promise<ExecutionResult> {
    if (d.verdict !== "allow") throw new Error("refusing to execute a non-allow decision");
    if (!d.to) throw new Error("decision has no recipient");
    // USDC is the native token on Arc, so `transfer` without --token is USDC there. On any other chain the
    // same command would move the native coin — refuse rather than guess.
    if (!(opts.chain in EXPLORER)) throw new Error(`CircleCliExecutor supports ARC and ARC-TESTNET only, got ${opts.chain}`);
    const executedAt = opts.now.toISOString();
    const steps: Array<{ step: string; raw: unknown }> = [];
    let swapTxHash: string | undefined;
    try {
      const amount = fixed6(d.amount);
      const transferArgs = ["wallet", "transfer", d.to, "--amount", amount, "--address", opts.from, "--chain", opts.chain, "--output", "json"];
      if (d.currency !== "USDC") {
        const token = TOKEN_CONTRACTS[opts.chain]?.[d.currency];
        if (!token) throw new Error(`no ${d.currency} contract known for ${opts.chain}`);
        // Treasury holds USDC: quote, then swap just enough USDC into the vendor's currency (stop-limit = exact amount owed).
        const q = await this.run(["wallet", "swap", "USDC", "1", d.currency, "--chain", opts.chain, "--quote", "--output", "json"]);
        steps.push({ step: "quote", raw: q.raw });
        const rate = Number(q.data?.estimatedOutput);
        // USDC↔EURC should be near parity; a wild quote means a broken route, not a bargain. Never let a quote
        // decide how much USDC leaves the treasury: the sell amount is capped relative to what Guardian approved.
        if (!(rate >= 0.5 && rate <= 2)) throw new Error(`swap quote out of sane range (1 USDC → ${q.data?.estimatedOutput} ${d.currency}); refusing`);
        // Observed on Arc testnet 2026-10-01: routing succeeds for whole-number sell amounts with an explicit
        // stop-limit (e.g. "USDC 1 EURC 0.8") and fails ("No route available") for fractional ones (3.8, 3.79).
        // So: sell a whole number of USDC with ≥10% headroom, stop-limit = exactly what is owed, slippage sized to match.
        const sell = Math.max(1, Math.ceil((d.amount / rate) * 1.1));
        const sellCap = Math.ceil(d.amount * 1.5) + 1;
        if (sell > sellCap) throw new Error(`swap would sell ${sell} USDC for ${d.amount} ${d.currency}; cap is ${sellCap}`);
        const expected = sell * rate;
        const slippageBps = Math.min(9000, Math.ceil((1 - d.amount / expected) * 10000) + 100);
        const sw = await this.run(["wallet", "swap", "USDC", String(sell), d.currency, amount, "--address", opts.from, "--chain", opts.chain, "--slippage-bps", String(slippageBps), "--idempotency-key", `swap-${d.intentId}`, "--output", "json"]);
        steps.push({ step: "swap", raw: sw.raw });
        // shape seen 2026-10-01: { data: { transactions: [ {approve…}, {swap…} ] } } — last one is the swap itself
        const txs = (sw.data?.transactions as Array<{ txHash?: string; state?: string }> | undefined) ?? [];
        const last = txs[txs.length - 1];
        swapTxHash = last?.txHash ?? (typeof sw.data?.txHash === "string" ? (sw.data.txHash as string) : undefined);
        const swState = String(last?.state ?? sw.data?.state ?? "");
        if (!/COMPLETE|CONFIRMED/.test(swState)) throw new Error(`swap ended in state ${swState || "unknown"}`);
        transferArgs.push("--token", token);
      }
      const tr = await this.run(transferArgs);
      steps.push({ step: "transfer", raw: tr.raw });
      const data = tr.data as Partial<CircleTransferResponse["data"]> | undefined;
      if (!data || typeof data.id !== "string") {
        return { intentId: d.intentId, ok: false, error: "unexpected circle cli output (no data.id)", raw: steps, executedAt };
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
        swapTxHash,
        error: terminalOk ? undefined : `transfer ended in state ${data.state}`,
        raw: steps.length > 1 ? steps : tr.raw,
        executedAt,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      // We cannot know whether the CLI broadcast before it failed (timeout, network, non-zero exit after send).
      // Record everything we do know; the engine treats any attempt under this intentId as spent.
      const broadcastUnknown = e.killed || /timeout|ETIMEDOUT|ECONNRESET|socket/i.test(e.message ?? "");
      return {
        intentId: d.intentId,
        ok: false,
        state: broadcastUnknown ? "UNKNOWN" : undefined,
        swapTxHash,
        error: (e.stderr || e.message || "circle cli failed").trim() + (swapTxHash ? ` [USDC→${d.currency} swap already executed: ${swapTxHash}; EURC is sitting in the treasury]` : ""),
        raw: steps.length ? steps : e.stdout ? safeJson(e.stdout) : undefined,
        executedAt,
      };
    }
  }
}

/** Token amounts as plain decimals for the CLI (never 1e-7 or 0.30000000000000004). */
export function fixed6(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _unparsed: s };
  }
}
