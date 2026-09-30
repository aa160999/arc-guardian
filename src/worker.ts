#!/usr/bin/env node
/**
 * File-queue worker.
 *
 * Runs on the machine that holds the Circle agent-wallet session (your laptop).
 * Anything that can write a JSON file into `data/queue/` — a human, a coding
 * agent in a sandbox, a cron job — can ask Guardian to pay. The wallet session
 * never leaves this machine; the policy still decides.
 *
 *   data/queue/<name>.json       ← PaymentIntent
 *   data/results/<name>.json     → { decision, execution? } or { error }
 *   data/queue/done|failed/      ← processed inputs are moved here
 *
 * Usage:  npm run worker            (real: pays via circle CLI)
 *         npm run worker -- --dry-run
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadDotenv } from "./env.js";
import { CircleCliExecutor, DryRunExecutor } from "./executors.js";
import { Guardian } from "./guardian.js";
import { Ledger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { defaultAllowlist, makeRunnerDirs, processCommandsOnce } from "./runner.js";

export interface WorkerDirs {
  queue: string;
  done: string;
  failed: string;
  results: string;
}

export function makeDirs(root: string): WorkerDirs {
  const d = { queue: join(root, "queue"), done: join(root, "queue", "done"), failed: join(root, "queue", "failed"), results: join(root, "results") };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  return d;
}

/** Process every settled (not-still-being-written) intent file once. Returns names handled. */
export async function processQueueOnce(dirs: WorkerDirs, guardian: Guardian, opts: { settleMs?: number; now?: () => number } = {}): Promise<string[]> {
  const settleMs = opts.settleMs ?? 1500;
  const nowMs = opts.now?.() ?? Date.now();
  const files = readdirSync(dirs.queue)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dirs.queue, f))
    .filter((p) => statSync(p).isFile() && nowMs - statSync(p).mtimeMs >= settleMs)
    .sort();

  const handled: string[] = [];
  for (const path of files) {
    const name = basename(path, ".json");
    const resultPath = join(dirs.results, `${name}.json`);
    try {
      const intent = JSON.parse(readFileSync(path, "utf8"));
      const out = await guardian.pay(intent);
      writeFileSync(resultPath, JSON.stringify({ file: basename(path), ...out }, null, 2) + "\n");
      renameSync(path, join(dirs.done, basename(path)));
      const tx = out.execution?.txHash ?? out.execution?.providerId ?? "";
      console.log(`[worker] ${name}: ${out.decision.verdict}${tx ? " tx=" + tx : ""}${out.execution && !out.execution.ok ? " EXEC-FAILED " + out.execution.error : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFileSync(resultPath, JSON.stringify({ file: basename(path), error: message }, null, 2) + "\n");
      renameSync(path, join(dirs.failed, basename(path)));
      console.error(`[worker] ${name}: ERROR ${message}`);
    }
    handled.push(name);
  }
  return handled;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(lockPath: string): void {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  if (existsSync(lockPath)) {
    const other = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(other) && other !== process.pid && pidAlive(other)) {
      throw new Error(`another worker (pid ${other}) is already running on this data dir — stop it first (Ctrl+C there, or: kill ${other})`);
    }
  }
  writeFileSync(lockPath, String(process.pid));
  const release = () => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

async function main() {
  loadDotenv();
  const dryRun = process.argv.includes("--dry-run");
  const ivIdx = process.argv.indexOf("--interval");
  const intervalMs = ivIdx > -1 ? Number(process.argv[ivIdx + 1]) : 2000;

  const policyPath = process.env.GUARDIAN_POLICY ?? "./policy.yaml";
  const ledgerPath = process.env.GUARDIAN_LEDGER ?? "./data/guardian.ledger.jsonl";
  const from = process.env.GUARDIAN_TREASURY_ADDRESS;
  const chain = process.env.GUARDIAN_CHAIN ?? "ARC-TESTNET";
  const root = process.env.GUARDIAN_DATA ?? "./data";
  if (!from && !dryRun) throw new Error("GUARDIAN_TREASURY_ADDRESS is required (or pass --dry-run)");
  if (!existsSync(policyPath)) throw new Error(`policy not found: ${policyPath}`);

  // Exactly one worker per data dir. Two workers would race on the queue and, worse,
  // hold two separate in-memory ledgers — the second could pay an intent the first already paid.
  acquireLock(join(root, "worker.lock"));

  const executor = dryRun ? new DryRunExecutor() : new CircleCliExecutor();
  // The ledger file may also be appended by `guardian approve` run outside this process,
  // so always evaluate against a fresh read: reload whenever the file changed under us.
  const ledgerMtime = () => (existsSync(ledgerPath) ? statSync(ledgerPath).mtimeMs : 0);
  const build = () => new Guardian({ policy: loadPolicy(policyPath), ledger: new Ledger(ledgerPath), executor, from: from ?? "0xdry", chain });
  let guardian = build();
  let policyMtime = statSync(policyPath).mtimeMs;
  let seenLedgerMtime = ledgerMtime();
  const dirs = makeDirs(root);
  const runnerDirs = makeRunnerDirs(root);
  const allow = defaultAllowlist();
  console.log(`[worker] ${dryRun ? "DRY-RUN" : "LIVE"} chain=${chain} from=${from ?? "-"} policy=${policyPath} watching ${dirs.queue} every ${intervalMs}ms`);
  console.log(`[runner] watching ${runnerDirs.cmd} — allowed: ${Object.keys(allow).join(", ")}`);

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Hot-reload the policy when the human edits it. A broken edit keeps the last good policy.
      const m = statSync(policyPath).mtimeMs;
      if (m !== policyMtime) {
        try {
          guardian = build();
          policyMtime = m;
          console.log(`[worker] policy reloaded from ${policyPath}`);
        } catch (e) {
          console.error(`[worker] policy NOT reloaded (keeping previous): ${e instanceof Error ? e.message : e}`);
          policyMtime = m;
        }
      }
      if (ledgerMtime() !== seenLedgerMtime) {
        guardian = build();
        console.log("[worker] ledger changed on disk — reloaded");
      }
      await processQueueOnce(dirs, guardian);
      seenLedgerMtime = ledgerMtime();
      await processCommandsOnce(runnerDirs, allow, process.cwd());
      if (ledgerMtime() !== seenLedgerMtime) {
        guardian = build();
        seenLedgerMtime = ledgerMtime();
      }
    } catch (e) {
      console.error("[worker] tick failed:", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
