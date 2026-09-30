#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { loadDotenv } from "./env.js";
import { CircleCliExecutor, DryRunExecutor } from "./executors.js";

loadDotenv();
import { Guardian } from "./guardian.js";
import { Ledger } from "./ledger.js";
import { loadPolicy } from "./policy.js";

const env = (k: string, d?: string) => process.env[k] ?? d;

function build(opts: { policy?: string; ledger?: string; from?: string; chain?: string; dryRun?: boolean }) {
  const policyPath = opts.policy ?? env("GUARDIAN_POLICY", "./policy.yaml")!;
  const ledgerPath = opts.ledger ?? env("GUARDIAN_LEDGER", "./data/guardian.ledger.jsonl")!;
  const from = opts.from ?? env("GUARDIAN_TREASURY_ADDRESS");
  const chain = opts.chain ?? env("GUARDIAN_CHAIN", "ARC-TESTNET")!;
  if (!from && !opts.dryRun) throw new Error("treasury address required: --from or GUARDIAN_TREASURY_ADDRESS");
  const policy = loadPolicy(policyPath);
  const ledger = new Ledger(ledgerPath);
  const executor = opts.dryRun ? new DryRunExecutor() : new CircleCliExecutor();
  return { guardian: new Guardian({ policy, ledger, executor, from: from ?? "0xdry", chain }), ledger, policy };
}

function readIntent(file: string): unknown {
  return JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
}

const program = new Command();
program
  .name("guardian")
  .description("Spending guardrails + hash-chained decision ledger for agents paying USDC on Arc")
  .option("-p, --policy <path>", "policy yaml (default $GUARDIAN_POLICY or ./policy.yaml)")
  .option("-l, --ledger <path>", "ledger jsonl (default $GUARDIAN_LEDGER)")
  .option("--from <address>", "treasury agent wallet (default $GUARDIAN_TREASURY_ADDRESS)")
  .option("--chain <chain>", "ARC-TESTNET | ARC (default $GUARDIAN_CHAIN)");

program
  .command("check <intent.json>")
  .description("evaluate an intent against policy; writes the decision to the ledger, moves nothing")
  .action((file) => {
    const { guardian } = build({ ...program.opts(), dryRun: true });
    const d = guardian.check(readIntent(file));
    console.log(JSON.stringify(d, null, 2));
    process.exitCode = d.verdict === "allow" ? 0 : d.verdict === "hold" ? 2 : 3;
  });

program
  .command("pay <intent.json>")
  .description("evaluate and, if allowed, pay via the Circle agent wallet CLI")
  .option("--dry-run", "do not call circle; record a fake execution")
  .action(async (file, cmd) => {
    const { guardian } = build({ ...program.opts(), dryRun: !!cmd.dryRun });
    const out = await guardian.pay(readIntent(file));
    console.log(JSON.stringify(out, null, 2));
    if (out.decision.verdict !== "allow") process.exitCode = out.decision.verdict === "hold" ? 2 : 3;
    else if (out.execution && !out.execution.ok) process.exitCode = 4;
  });

program
  .command("approve <intentId>")
  .description("human lifts a HOLD; prints the approvalToken the agent must resubmit with")
  .requiredOption("--by <approver>", "who is approving")
  .option("--note <text>")
  .action((intentId, cmd) => {
    const { guardian } = build({ ...program.opts(), dryRun: true });
    console.log(guardian.approve(intentId, cmd.by, cmd.note));
  });

const ledgerCmd = program.command("ledger").description("inspect the append-only ledger");
ledgerCmd
  .command("verify")
  .description("recompute the hash chain")
  .action(() => {
    const { ledger } = build({ ...program.opts(), dryRun: true });
    const r = ledger.verify();
    console.log(JSON.stringify({ entries: ledger.length, head: ledger.headHash, ...r }, null, 2));
    if (!r.ok) process.exitCode = 1;
  });
ledgerCmd
  .command("summary")
  .description("what moved, to whom, with which rule hits")
  .action(() => {
    const { ledger } = build({ ...program.opts(), dryRun: true });
    const paid = ledger.settledPayments();
    const byVendor = new Map<string, { n: number; total: number }>();
    for (const p of paid) {
      const k = p.decision.vendorId ?? p.decision.to ?? "?";
      const cur = byVendor.get(k) ?? { n: 0, total: 0 };
      byVendor.set(k, { n: cur.n + 1, total: cur.total + p.decision.amount });
    }
    const decisions = ledger.all().filter((e) => e.kind === "decision");
    const counts = { allow: 0, hold: 0, deny: 0 } as Record<string, number>;
    for (const e of decisions) if (e.kind === "decision") counts[e.decision.verdict]++;
    console.log(
      JSON.stringify(
        {
          decisions: counts,
          paymentsSettled: paid.length,
          usdcMoved: paid.reduce((s, p) => s + p.decision.amount, 0),
          byVendor: Object.fromEntries(byVendor),
          chainOk: ledger.verify().ok,
        },
        null,
        2,
      ),
    );
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
