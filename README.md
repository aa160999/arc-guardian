# Arc Guardian

**Spending guardrails and a tamper-evident decision ledger for AI agents that pay in USDC on Arc.**

Guardian is the one door money leaves through. The agent proposes a payment
(an *intent*); Guardian evaluates it against a policy the business owner wrote,
records the decision in a hash-chained ledger, and only then lets the Circle
agent wallet move the USDC. The LLM never touches the policy and nothing in the
policy engine reads the LLM's prose — so an agent cannot talk its way past it.

> Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com/) (Canteen × Circle, Sep 27 – Oct 10 2026).
> Status: **week 1 / day 1** — policy engine, ledger, CLI, worker and the Circle CLI executor are done and tested.
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
on chain. `guardian ledger verify` proves nobody edited it after the fact.

## What it checks

| Rule | Verdict | What it catches |
| --- | --- | --- |
| `idempotency` | deny | same `intentId` executing twice (retries, crashed runs) |
| `known-recipient` | deny / hold | payee not in the vendor registry (policy chooses) |
| `recipient-mismatch` | deny | `vendorId` and `to` disagree — the invoice-fraud shape |
| `currency` | deny | paying a vendor in a token they don't accept |
| `risk-tier` | hold | high-risk vendors always need a human |
| medium risk | — | caps multiplied by `mediumRiskCapMultiplier` (default 0.5) |
| `duplicate-invoice` | deny | same vendor + same `invoiceId` already settled |
| `possible-duplicate` | hold | same vendor + same amount inside `duplicateWindowDays` |
| `cap:*` | deny | per-tx and rolling daily/weekly/monthly, global and per vendor |
| `approval-threshold` | hold | amount ≥ threshold needs `guardian approve` |
| `approval` | allow / deny | a recorded token lifts a **hold** (never a deny), and only for the exact `(to, amount, currency)` that was held |

Circle stack used: **Agent Wallets** (custody, gas sponsored in USDC), **USDC** native settlement, **EURC** via **Swap** for vendors that invoice in euros, **Gateway** unified balance in the treasury view, **Contracts** lookups for token addresses.

Deny always beats hold; hold always beats allow.

## Quickstart (dry run, no wallet needed)

```bash
npm install
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
`src/runner.ts` can run (tests, typecheck, git add/commit/push, `gh repo create`,
read-only `circle` queries, `arc-canteen update`). No shell is ever spawned,
free-text args are validated, and interactive logins are deliberately absent.

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
