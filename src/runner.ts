/**
 * Allow-listed command runner, driven by files — same idea as the payment queue.
 *
 *   data/cmd/<name>.json            ← { "run": "npm-test" }  or  { "run": "git-commit", "args": ["message"] }
 *   data/cmd/results/<name>.json    → { ok, exitCode, stdout, stderr, durationMs }
 *   data/cmd/done|failed/           ← processed inputs
 *
 * Only commands in ALLOW can run, each with a fixed argv. No shell is ever
 * invoked (execFile with an argv array), and free-text args are validated
 * against a conservative character set. Anything interactive (logins, OTP)
 * is deliberately not here — the human does those in their own terminal.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface CmdSpec {
  /** argv to run; strings equal to "$1", "$2"… are replaced by validated args. */
  argv: string[];
  /** How many free-text args are required. */
  args?: number;
  timeoutMs?: number;
  /** Optional guard run before executing; throw to refuse. */
  guard?: (cwd: string) => void;
  /** Optional Node-side action instead of spawning. */
  action?: (cwd: string) => Promise<string>;
  description: string;
}

const SAFE_ARG = /^[\p{L}\p{N} .,:;!?'"()\-_/@#+=\[\]%&*~\n]{1,400}$/u;
/** Free-text args may never look like a flag or climb directories. */
function argOk(a: unknown): a is string {
  return typeof a === "string" && SAFE_ARG.test(a) && !a.startsWith("-") && !a.includes("..");
}

function requireNoCommits(cwd: string) {
  // refuse to wipe a .git that already has history
  if (!existsSync(join(cwd, ".git"))) return;
  const head = join(cwd, ".git", "HEAD");
  const refs = join(cwd, ".git", "refs", "heads");
  if (existsSync(head) && existsSync(refs) && readdirSync(refs).length > 0) throw new Error(".git already has commits; refusing to re-init");
}

/**
 * "core": what an operator legitimately needs from a remote agent — tests, ledger inspection, the AP
 * agent, plain git, read-only Circle queries. Nothing here moves funds: payments only go through the
 * Guardian queue. "dev" adds this repo's own release/demo tooling (GitHub Pages, screenshots, TTS,
 * Canteen updates, history rewrites). Enable with GUARDIAN_RUNNER_PROFILE=dev.
 */
export function defaultAllowlist(env: NodeJS.ProcessEnv = process.env, profile: "core" | "dev" = "core"): Record<string, CmdSpec> {
  const treasury = env.GUARDIAN_TREASURY_ADDRESS ?? "";
  const chain = env.GUARDIAN_CHAIN ?? "ARC-TESTNET";
  const core: Record<string, CmdSpec> = {
    "npm-install": { argv: ["npm", "install", "--no-audit", "--no-fund"], timeoutMs: 600_000, description: "install deps" },
    "npm-test": { argv: ["npm", "test", "--silent"], timeoutMs: 300_000, description: "run vitest" },
    "npm-typecheck": { argv: ["npm", "run", "--silent", "typecheck"], timeoutMs: 300_000, description: "tsc --noEmit" },
    "llm-ping": { argv: ["npm", "run", "--silent", "llm-ping"], timeoutMs: 60_000, description: "check LLM key/model from .env (key never printed)" },
    "ap-run": { argv: ["npm", "run", "--silent", "ap"], timeoutMs: 600_000, description: "AP agent: read data/invoices, decide, queue intents" },
    "ap-dry": { argv: ["npm", "run", "--silent", "ap", "--", "--dry"], timeoutMs: 600_000, description: "AP agent decisions only, no intents" },
    "report": { argv: ["npm", "run", "--silent", "report"], description: "regenerate docs/index.html from ledger + AP records" },
    "circle-contracts": { argv: ["circle", "contract", "address", "--chain", chain, "--output", "json"], description: "Circle contract addresses on this chain" },
    "circle-gateway-balance": { argv: ["circle", "gateway", "balance", "--address", treasury, "--chain", chain, "--all", "--output", "json"], description: "Gateway unified balance" },
    "circle-swap-quote": { argv: ["circle", "wallet", "swap", "USDC", "1", "EURC", "--chain", chain, "--quote", "--output", "json"], description: "quote 1 USDC → EURC on this chain" },
    "npm-build": { argv: ["npm", "run", "--silent", "build"], timeoutMs: 300_000, description: "tsc build" },
    "guardian-ledger-verify": { argv: ["npm", "run", "--silent", "guardian", "--", "ledger", "verify"], description: "verify ledger chain" },
    "guardian-ledger-summary": { argv: ["npm", "run", "--silent", "guardian", "--", "ledger", "summary"], description: "ledger summary" },
    "guardian-approve": { argv: ["npm", "run", "--silent", "guardian", "--", "approve", "$1", "--by", "$2"], args: 2, description: "lift a hold: <intentId> <approver>" },
    "git-status": { argv: ["git", "status", "--short", "--branch"], description: "git status" },
    "git-log": { argv: ["git", "log", "--oneline", "-n", "20"], description: "recent commits" },
    "git-init": { argv: ["git", "init", "-b", "main"], guard: requireNoCommits, description: "git init -b main" },
    "git-add": { argv: ["git", "add", "-A"], description: "git add -A" },
    "git-commit": { argv: ["git", "commit", "-m", "$1"], args: 1, description: "git commit -m <msg>" },
    "git-push": { argv: ["git", "push", "-u", "origin", "main"], timeoutMs: 120_000, description: "push main" },
    "circle-balance": { argv: ["circle", "wallet", "balance", "--address", treasury, "--chain", chain, "--output", "json"], description: "treasury balance" },
    "circle-wallet-list": { argv: ["circle", "wallet", "list", "--chain", chain, "--type", "agent", "--output", "json"], description: "list agent wallets" },
    "circle-tx-list": { argv: ["circle", "transaction", "list", "--address", treasury, "--chain", chain, "--output", "json"], description: "treasury tx history" },
    "circle-status": { argv: ["circle", "wallet", "status", "--type", "agent"], description: "session status" },
  };
  const dev: Record<string, CmdSpec> = {
    "gh-pages-enable": { argv: ["gh", "api", "-X", "POST", "repos/aa160999/arc-guardian/pages", "-f", "source[branch]=main", "-f", "source[path]=/docs"], description: "enable GitHub Pages from /docs on main" },
    "tts": { argv: ["npm", "run", "--silent", "tts"], timeoutMs: 600_000, description: "narrate video/script.json with Gemini TTS → data/video/audio" },
    "chrome-shot-ledger": {
      argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=10000", "--window-size=1600,2400", "--screenshot=data/video/shot-ledger.png", "https://aa160999.github.io/arc-guardian/"],
      timeoutMs: 60_000,
      description: "headless Chrome screenshot of the live ledger page → data/video/shot-ledger.png",
    },
    "chrome-shot-explorer": {
      argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=10000", "--window-size=1600,1000", "--screenshot=data/video/shot-explorer.png", "https://explorer.testnet.arc.io/tx/0x119e09071ae386c5cc87dbc261d52cd5a928b0913024c912d625e134d8256219"],
      timeoutMs: 60_000,
      description: "headless Chrome screenshot of the approved tx on Arc explorer",
    },
    "transcribe": { argv: ["npm", "run", "--silent", "transcribe", "--", "$1"], args: 1, timeoutMs: 120_000, description: "transcribe a wav under data/video/audio for QA" },
    "git-reinit": {
      argv: ["git", "init", "-b", "main"],
      guard: requireNoCommits,
      action: async (cwd) => {
        requireNoCommits(cwd);
        rmSync(join(cwd, ".git"), { recursive: true, force: true });
        return "removed broken .git";
      },
      description: "wipe a commit-less .git and re-init (used once to fix the sandbox-created repo)",
    },
    "git-config-name": { argv: ["git", "config", "user.name", "$1"], args: 1, description: "repo-local commit author name" },
    "git-config-email": { argv: ["git", "config", "user.email", "$1"], args: 1, description: "repo-local commit author email" },
    "git-amend-reset-author": { argv: ["git", "commit", "--amend", "--no-edit", "--reset-author"], description: "re-stamp last commit with the configured author" },
    "git-reauthor-all": {
      argv: ["git", "rebase", "--root", "--committer-date-is-author-date", "-x", "git commit --amend --no-edit --reset-author"],
      timeoutMs: 120_000,
      description: "re-stamp EVERY commit with the configured author (fixed exec string, no user input)",
    },
    "git-push-force-lease": { argv: ["git", "push", "--force-with-lease", "origin", "main"], timeoutMs: 120_000, description: "force push main (with lease) after a history rewrite" },
    "gh-repo-create": { argv: ["gh", "repo", "create", "$1", "--public", "--source=.", "--push"], args: 1, timeoutMs: 180_000, description: "create public GitHub repo <name> from this dir and push" },
    "gh-auth-status": { argv: ["gh", "auth", "status"], description: "is gh logged in?" },
    "canteen-status": { argv: ["arc-canteen", "status"], description: "canteen dashboard" },
    "canteen-update-product": { argv: ["arc-canteen", "update", "product", "$1"], args: 1, description: "submit a product update to Canteen" },
    "canteen-update-traction": { argv: ["arc-canteen", "update", "traction", "$1"], args: 1, description: "submit a traction update to Canteen" },
  };
  return profile === "dev" ? { ...core, ...dev } : core;
}

export interface RunnerDirs {
  cmd: string;
  done: string;
  failed: string;
  results: string;
}

export function makeRunnerDirs(root: string): RunnerDirs {
  const d = { cmd: join(root, "cmd"), done: join(root, "cmd", "done"), failed: join(root, "cmd", "failed"), results: join(root, "cmd", "results") };
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  return d;
}

export interface CmdResult {
  file: string;
  run: string;
  argv?: string[];
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
  finishedAt: string;
}

const MAX_OUT = 200_000;
const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s);

export function resolveCommand(allow: Record<string, CmdSpec>, req: { run: string; args?: unknown }): { spec: CmdSpec; argv: string[] } {
  const spec = allow[req.run];
  if (!spec) throw new Error(`command not allowed: ${req.run}. Allowed: ${Object.keys(allow).join(", ")}`);
  const args = Array.isArray(req.args) ? req.args : [];
  const need = spec.args ?? 0;
  if (args.length !== need) throw new Error(`${req.run} needs exactly ${need} arg(s), got ${args.length}`);
  for (const a of args) {
    if (!argOk(a)) throw new Error(`arg rejected by validator: ${JSON.stringify(a)}`);
  }
  const argv = spec.argv.map((t) => (/^\$\d+$/.test(t) ? String(args[Number(t.slice(1)) - 1]) : t));
  return { spec, argv };
}

/** PATH with the usual user-tool dirs (uv/pipx put `arc-canteen` in ~/.local/bin, npm -g often in /opt/homebrew/bin). */
function toolPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const cur = (process.env.PATH ?? "").split(":");
  return [...extra.filter((p) => !cur.includes(p)), ...cur].join(":");
}

export function runArgv(argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Children re-read .env themselves; don't hand them the values this long-running worker loaded at startup.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: toolPath(), CIRCLE_ACCEPT_TERMS: "1", GIT_TERMINAL_PROMPT: "0" };
    for (const k of Object.keys(env)) if (k.startsWith("LLM_")) delete env[k];
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 8 << 20, env }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const exitCode = e ? (typeof e.code === "number" ? e.code : e.killed ? null : 1) : 0;
      resolve({ exitCode, stdout: clip(String(stdout ?? "")), stderr: clip(String(stderr ?? "") + (e && typeof e.code === "string" ? `\n${e.code}: ${e.message}` : "")) });
    });
  });
}

export async function processCommandsOnce(dirs: RunnerDirs, allow: Record<string, CmdSpec>, cwd: string, opts: { settleMs?: number; now?: () => number } = {}): Promise<string[]> {
  const settleMs = opts.settleMs ?? 1500;
  const nowMs = opts.now?.() ?? Date.now();
  const files = readdirSync(dirs.cmd)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dirs.cmd, f))
    .filter((p) => statSync(p).isFile() && nowMs - statSync(p).mtimeMs >= settleMs)
    .sort();

  const handled: string[] = [];
  for (const path of files) {
    const name = basename(path, ".json");
    const started = Date.now();
    let result: CmdResult;
    let req: { run: string; args?: unknown } = { run: "?" };
    try {
      req = JSON.parse(readFileSync(path, "utf8"));
      const { spec, argv } = resolveCommand(allow, req);
      spec.guard?.(cwd);
      let pre = "";
      if (spec.action) pre = (await spec.action(cwd)) + "\n";
      const r = await runArgv(argv, cwd, spec.timeoutMs ?? 120_000);
      result = { file: basename(path), run: req.run, argv, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: pre + r.stdout, stderr: r.stderr, durationMs: Date.now() - started, finishedAt: new Date().toISOString() };
    } catch (err) {
      result = { file: basename(path), run: req.run, ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started, finishedAt: new Date().toISOString() };
    }
    writeFileSync(join(dirs.results, `${name}.json`), JSON.stringify(result, null, 2) + "\n");
    renameSync(path, join(result.ok ? dirs.done : dirs.failed, basename(path)));
    console.log(`[runner] ${name}: ${result.run} → ${result.ok ? "ok" : "FAILED"}${result.exitCode != null ? " exit=" + result.exitCode : ""}${result.error ? " " + result.error : ""} (${result.durationMs}ms)`);
    handled.push(name);
  }
  return handled;
}
