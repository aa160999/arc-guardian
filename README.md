# Arc Guardian

**Spending guardrails and a hash-chained, tamper-evident decision ledger for AI agents that pay in USDC on Arc.**

Guardian is the one door money leaves through. The agent proposes a payment
(an *intent*); Guardian evaluates it against a policy the business owner wrote,
records the decision in a hash-chained ledger, and only then lets the Circle
agent wallet move the USDC. The LLM never touches the policy and nothing in the
policy engine reads the LLM's prose — so an agent cannot talk its way past it.

> Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com/) (Canteen × Circle, Sep 27 – Oct 10 2026).
> **Demo video (3 min):** https://youtu.be/2DwY6gnQPqw · **Live ledger:** https://aa160999.github.io/arc-guardian/
> Status (Oct 1): policy engine, ledger, CLI, worker/runner, Circle CLI executor (USDC + EURC via swap), reference AP agent, live ledger page — all exercised on Arc testnet.
> First live payment on Arc testnet went through Guardian on 2026-09-27:
> [`0x0f13e2…c216`](https://explorer.testnet.arc.io/tx/0x0f13e232762a0844cec750c173517b109ae775b2cef1b6d12a7cd5181733c216)
> (1.5 USDC, gas 0.035 USDC). A replay of the same intent and a re-sent invoice were both denied without moving funds.

## Why this exists

Circle's agent wallets already ship spending policies — per-tx/daily/weekly/monthly
caps and address allow/blocklists. They are the right hard floor, and Guardian
does not replace them. Two gaps remain, and both are exactly where an agent
managing a business's money goes wrong:

1. **Testnet has no policies.** Circle spending policies are mainnet-only. Every
   team building on Arc testnet today runs an agent with an unbounded wallet.
   Guardian gives testnet the same shape of control, in-process, in one line.
2. **Address caps don't know what an invoice is.** A cap can't tell that
   `INV-100` was already paid, that the "urgent new supplier" is not in the
   vendor registry, that the vendor id and the payee address disagree, or that
   a retry is about to pay the same bill twice. Those are the mistakes the
   [*Agents and Ledgers*](https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html)
   piece points out a balanced ledger will never catch.

And once an agent can spend without asking first, the record it leaves behind is
what makes it trustworthy. Guardian's ledger is append-only and hash-chained:
every decision commits to what the agent saw, which rule fired, and what went
on chain. `guardian ledger verify` (and the button on the ledger page) recomputes the chain: any edited or
deleted entry breaks it at that seq. Truncating the tail is only detectable against an external
anchor — signing the head hash with the treasury wallet is on the roadmap.

## What it checks

| Rule | Verdict | What it catches |
| --- | --- | --- |
| `idempotency` | deny | same `intentId` again after *any* prior attempt — confirmed, failed or unknown. The CLI may have broadcast before it errored, so a human reconciles and re-issues under a new id if the money truly did not move |
| `known-recipient` | deny / hold | payee not in the vendor registry (policy chooses) |
| `recipient-mismatch` | deny | `vendorId` and `to` disagree — the invoice-fraud shape |
| `currency` | deny | paying a vendor in a token they don't accept |
| `risk-tier` | hold | high-risk vendors always need a human |
| medium risk | — | caps multiplied by `mediumRiskCapMultiplier` (default 0.5) |
| `duplicate-invoice` | deny | same vendor + same invoice already settled (`"#INV-1234"` and `"inv 1234"` compare equal) |
| `possible-duplicate` | hold | same vendor + same amount inside `duplicateWindowDays` |
| `cap:*` | deny | per-tx and rolling daily/weekly/monthly, global and per vendor; counted per token (USDC caps count USDC, EURC caps count EURC) |
| `approval-threshold` | hold | amount ≥ threshold needs `guardian approve` |
| `approval` | allow / hold | a recorded token lifts a **hold** (never a deny) — only for the exact `(to, amount, currency)` and the exact set of hold rules present when it was granted. A hold that appears later (say, `possible-duplicate`) needs a fresh approval. A wrong or stale token lifts nothing; the intent stays held |

Circle stack used: **Agent Wallets** (custody, gas sponsored in USDC), **USDC** native settlement, **EURC** via **Swap** for vendors that invoice in euros, **Gateway** unified balance in the treasury view, **Contracts** lookups for token addresses.

Deny always beats hold; hold always beats allow. Approving is a human act: `guardian approve <intentId> --by <name>` runs in the owner's terminal and is deliberately **not** available through the file-driven runner — the agent that proposes payments can never approve its own holds.

## Install

```bash
npm install arc-guardian        # library + `guardian` CLI
# or, for your own agent in one line:
import { Guardian } from "arc-guardian";
```

## Quickstart (dry run, no wallet needed)

```bash
git clone https://github.com/aa160999/arc-guardian && cd arc-guardian && npm install
cp policy.example.yaml policy.yaml         # edit vendors/caps for your business
npm run guardian -- pay --dry-run examples/intent-anthropic-bill.json
npm run guardian -- check examples/intent-unknown-recipient.json     # → deny
npm run guardian -- ledger verify
npm run guardian -- ledger summary
```

Exit codes: `0` allow, `2` hold, `3` deny, `4` allowed but execution failed.

## Paying for real on Arc testnet

Guardian executes through the official Circle CLI, so the wallet session (email
OTP, stored in your OS keychain) is never exposed to the agent.

```bash
npm install -g @circle-fin/cli
circle wallet login you@example.com --testnet          # enter the OTP yourself
circle wallet list --chain ARC-TESTNET --type agent     # copy the treasury address
circle wallet fund --address 0xTreasury --chain ARC-TESTNET   # 20 USDC from the faucet

cp .env.example .env    # set GUARDIAN_TREASURY_ADDRESS, GUARDIAN_CHAIN=ARC-TESTNET
npm run guardian -- pay examples/intent-anthropic-bill.json
```

Vendor addresses in `policy.yaml` must be real Arc testnet wallets you control
(`circle wallet create --type agent --testnet`, up to 5 per account) or your
counterparties' addresses.

### Let an agent elsewhere drive payments without holding the session

`npm run worker` watches `data/queue/*.json` on the machine that has the wallet
session and pays each intent through Guardian, writing `{decision, execution}`
to `data/results/`. A coding agent in a sandbox, a cron job, or a teammate can
queue intents by dropping files; the OTP session never leaves your laptop and
the policy still decides. Add `--dry-run` to rehearse.

The same worker also runs an **allow-listed command runner**: drop
`{ "run": "npm-test" }` or `{ "run": "git-commit", "args": ["msg"] }` into
`data/cmd/` and read `data/cmd/results/`. Only fixed argv entries in
`src/runner.ts` can run. The default `core` profile is tests, typecheck, the AP agent, ledger
inspection, plain git and read-only `circle` queries — nothing that moves funds and nothing that approves. `GUARDIAN_RUNNER_PROFILE=dev`
adds this repo's own release/demo tooling. No shell is ever spawned, free-text args are validated
(no leading `-`, no `..`), and interactive logins are deliberately absent.

## Use it as a library

```ts
import { Guardian, Ledger, loadPolicy, CircleCliExecutor } from "arc-guardian";

const guardian = new Guardian({
  policy: loadPolicy("./policy.yaml"),
  ledger: new Ledger("./data/guardian.ledger.jsonl"),
  executor: new CircleCliExecutor(),
  from: process.env.GUARDIAN_TREASURY_ADDRESS!,
  chain: "ARC-TESTNET",
});

const { decision, execution } = await guardian.pay({
  intentId: "inv-2026-09-anthropic",
  vendorId: "anthropic",
  amount: 87.4,
  invoiceId: "ANTH-2026-09-001",
  reason: "September API usage; matches console statement",
});
```

Implement `Executor` to route through anything else (App Kit, a smart-contract
escrow, a test double). Guardian only ever calls `execute()` with an `allow`.

## Architecture

```
agent / LLM ──intent──▶ Guardian.pay()
                          │  evaluate(policy, ledger, intent)   pure, deterministic
                          │  ledger.append(decision)            hash-chained JSONL
                          ├─ allow ─▶ executor ─▶ circle wallet transfer ─▶ Arc
                          │             └────────▶ ledger.append(execution)
                          ├─ hold  ─▶ waits for `guardian approve <intentId> --by <human>`
                          └─ deny
```

- `src/types.ts` — zod schemas: `Policy`, `PaymentIntent`, `Decision`, `ExecutionResult`
- `src/engine.ts` — `evaluate()`; no I/O, no clock other than the one passed in
- `src/ledger.ts` — append-only, `sha256(prevHash + canonical(entry))`, `verify()`
- `src/executors.ts` — `DryRunExecutor`, `CircleCliExecutor`
- `src/guardian.ts` — orchestration + human approval flow
- `src/cli.ts` — `guardian check | pay | approve | ledger verify | ledger summary`

## Known limits (read before trusting it with real money)

- **Trust boundary is the folder, not the file.** The worker hot-reloads `policy.yaml`, and `npm-test` / `ap-run` execute whatever is in `src/`. If the agent's sandbox can write the whole repo, it can rewrite the policy. Give a sandboxed agent `data/queue/` only (bind-mount that directory, nothing else).
- **Caps are per token.** Global USDC and EURC caps are separate budgets, and the USDC consumed by a USDC→EURC swap is not charged against any cap. For a mixed-currency treasury, set the EURC caps with that in mind.
- **No pre-execution record.** If the process dies between a successful `circle` transfer and the ledger append, the payment is on chain but not in the ledger; the next attempt under the same id is blocked only if the failure was observed. Writing an "attempting" entry before calling the CLI is the fix and is not done yet.
- **No external anchor.** The hash chain detects edits and deletions in the middle. Truncating the tail or re-generating the whole chain is only detectable against a published head hash (next step: sign it with the treasury wallet; cheapest step: paste it into each Canteen update).
- **Arc only.** The executor refuses other chains: on Arc, USDC is the native token and `circle wallet transfer` without `--token` is USDC; elsewhere it would move the native coin.

## Roadmap (hackathon window)

- [x] First real transfer on Arc testnet through `CircleCliExecutor`; CLI JSON shape pinned in `CircleTransferResponse`
- [x] Reference AP agent (`npm run ap`): 6 real invoices (OpenAI in IDR, two proxy vendors) → Gemini extraction + judgement → FX → Guardian → paid on Arc testnet; one payment held as `possible-duplicate`, lifted via `guardian approve`, then paid
- [x] EURC vendors: quote → `circle wallet swap USDC n EURC <owed>` (whole-number sell, stop-limit = amount owed) → `transfer --token EURC`; live on testnet (swap 0xf01a17…, transfer 0x72a56c…)
- [x] Gateway: treasury view = wallet USDC + USDC parked in Circle Gateway (`circle gateway deposit --method direct`, tx 0x85087f…); shown to the agent and on the ledger page
- [ ] Optional: sign each ledger head with the treasury wallet (`circle wallet sign message`) so the chain is attributable, not just tamper-evident
- [ ] Optional: on-chain policy contract as a second, unbypassable layer
- [ ] Small web view over the ledger with Arc explorer links, for reviewers who click around without us in the room

## License

MIT
