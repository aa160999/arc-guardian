/**
 * `npm run report` → docs/index.html
 *
 * A single self-contained page a reviewer can open without us in the room:
 * summary, the full ledger timeline (decisions, executions, approvals, explorer links),
 * the AP agent's judgements with their reasoning, and a "Verify chain" button that
 * recomputes every hash in the browser — so the tamper-evidence claim is checkable, not asserted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotenv } from "./env.js";
import { explorerTxUrl } from "./executors.js";
import { Ledger, type LedgerEntry } from "./ledger.js";
import { loadPolicy, policyHash } from "./policy.js";
import type { Policy } from "./types.js";

export interface ReportInput {
  policy: Policy;
  ledger: Ledger;
  apRecords: unknown[];
  chain: string;
  treasury: string;
  repoUrl: string;
  generatedAt: string;
}

export function buildReportData(i: ReportInput) {
  const entries = i.ledger.all();
  const all = i.ledger.settledPayments();
  const isTest = (id: string) => /^test-/.test(id);
  const settled = all.filter((p) => !isTest(p.intent.intentId));
  const testPayments = all.filter((p) => isTest(p.intent.intentId));
  const latestAp = (i.apRecords as Array<{ at?: string; treasury?: { walletUsdc: number; gatewayUsdc: number } }>).filter((r) => r.treasury).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];
  const counts = { allow: 0, hold: 0, deny: 0 };
  for (const e of entries) if (e.kind === "decision") counts[e.decision.verdict]++;
  const byVendor: Record<string, { n: number; total: number }> = {};
  for (const p of settled) {
    const k = p.decision.vendorId ?? p.decision.to ?? "?";
    byVendor[k] = { n: (byVendor[k]?.n ?? 0) + 1, total: Math.round(((byVendor[k]?.total ?? 0) + p.decision.amount) * 100) / 100 };
  }
  return {
    generatedAt: i.generatedAt,
    business: i.policy.business,
    policyHash: policyHash(i.policy),
    chain: i.chain,
    treasury: i.treasury,
    repoUrl: i.repoUrl,
    explorerBase: (explorerTxUrl(i.chain, "") ?? "").replace(/\/tx\/$/, ""),
    summary: {
      decisions: counts,
      settled: settled.length,
      usdcMoved: Math.round(settled.reduce((s, p) => s + p.decision.amount, 0) * 100) / 100,
      testPayments: testPayments.length,
      byVendor,
      chainOk: i.ledger.verify().ok,
      entries: entries.length,
      treasury: latestAp?.treasury ?? null,
    },
    vendors: i.policy.vendors.map((v) => ({ id: v.id, name: v.name, riskTier: v.riskTier, caps: v.caps, notes: v.notes ?? "" })),
    caps: i.policy.caps,
    approvalThreshold: i.policy.approvalThreshold ?? null,
    ledger: entries as LedgerEntry[],
    ap: i.apRecords,
  };
}

export function renderHtml(data: ReturnType<typeof buildReportData>): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc Guardian — decision ledger · ${esc(data.business)}</title>
<style>
:root{--bg:#0b0d12;--card:#141824;--line:#232a3b;--fg:#e6e9f0;--mut:#8b93a7;--ok:#3ddc97;--hold:#ffcc4d;--deny:#ff5c7a;--acc:#6ea8ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Inter,Segoe UI,Roboto,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px;color:#c9d0e0}
.sub{color:var(--mut);font-size:13px}.sub code{font-family:var(--mono);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.card .v{font-size:26px;font-weight:600;margin-top:4px}
.card .v small{font-size:13px;color:var(--mut);font-weight:400}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;font-size:13.5px}th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.allow{background:rgba(61,220,151,.15);color:var(--ok)}.hold{background:rgba(255,204,77,.15);color:var(--hold)}.deny{background:rgba(255,92,122,.15);color:var(--deny)}
.kind{font-family:var(--mono);font-size:12px;color:var(--mut)}
.mono{font-family:var(--mono);font-size:12.5px}
.hit{display:block;font-family:var(--mono);font-size:12px;color:var(--mut)}.hit b{color:var(--fg);font-weight:500}
.reason{color:#c9d0e0}.anom{color:var(--hold);font-size:12.5px}
button{background:var(--acc);color:#0b0d12;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
#verify-out{margin-left:12px;font-family:var(--mono);font-size:13px}
.ok{color:var(--ok)}.bad{color:var(--deny)}
.foot{margin-top:40px;color:var(--mut);font-size:12.5px}
details summary{cursor:pointer;color:var(--mut);font-size:13px}
</style></head><body><div class="wrap">
<h1>Arc Guardian — decision ledger</h1>
<div class="sub">${esc(data.business)} · ${esc(data.chain)} · treasury <code>${esc(data.treasury)}</code> · policy <code>${data.policyHash.slice(0, 16)}…</code> · generated ${esc(data.generatedAt)} · <a href="${esc(data.repoUrl)}">source</a></div>

<div class="cards">
  <div class="card"><div class="k">Payments settled</div><div class="v" id="c-settled"></div></div>
  <div class="card"><div class="k">USDC moved</div><div class="v" id="c-moved"></div></div>
  <div class="card"><div class="k">Decisions</div><div class="v" id="c-dec"></div></div>
  <div class="card"><div class="k">Ledger entries</div><div class="v" id="c-entries"></div></div>
  <div class="card"><div class="k">Hash chain</div><div class="v" id="c-chain"></div></div>
  <div class="card"><div class="k">Treasury (wallet + Gateway)</div><div class="v" id="c-treasury"></div></div>
</div>

<p><button id="verify">Verify chain in this browser</button><span id="verify-out"></span></p>
<p class="sub">Every entry commits to the previous entry's SHA-256. Click to recompute all of them locally from the embedded data — if any line had been edited or removed after the fact, the chain would break at that seq.</p>

<h2>What the agent saw and concluded</h2>
<table id="ap"><thead><tr><th>Invoice</th><th>Vendor</th><th>Amount</th><th>AI action</th><th>Reasoning</th><th>USDC / intent</th></tr></thead><tbody></tbody></table>

<h2>Ledger timeline</h2>
<table id="ledger"><thead><tr><th>#</th><th>Time (UTC)</th><th>Kind</th><th>Intent</th><th>Vendor · amount</th><th>Verdict / result</th><th>Rules</th></tr></thead><tbody></tbody></table>

<h2>Policy the agent cannot edit</h2>
<table id="policy"><thead><tr><th>Vendor</th><th>Risk</th><th>Caps (USDC)</th><th>Owner notes</th></tr></thead><tbody></tbody></table>
<p class="sub" id="global-caps"></p>

<div class="foot">Money moves only through <code>Guardian.pay()</code>. The LLM proposes; the deterministic policy engine decides; the Circle agent wallet executes on Arc; the ledger records. <a href="${esc(data.repoUrl)}">github</a></div>
</div>
<script id="data" type="application/json">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pill = v => '<span class="pill '+v+'">'+v+'</span>';
const txlink = h => h ? '<a class="mono" href="'+D.explorerBase+'/tx/'+h+'" target="_blank" rel="noopener">'+h.slice(0,10)+'…'+h.slice(-6)+'</a>' : '';
$('#c-settled').textContent = D.summary.settled;
$('#c-moved').innerHTML = D.summary.usdcMoved + ' <small>USDC</small>';
$('#c-dec').innerHTML = D.summary.decisions.allow+' <small>allow</small> · '+D.summary.decisions.hold+' <small>hold</small> · '+D.summary.decisions.deny+' <small>deny</small>';
$('#c-entries').textContent = D.summary.entries;
$('#c-chain').innerHTML = D.summary.chainOk ? '<span class="ok">intact</span>' : '<span class="bad">BROKEN</span>';
$('#c-treasury').innerHTML = D.summary.treasury ? D.summary.treasury.walletUsdc+' <small>USDC wallet</small> + '+D.summary.treasury.gatewayUsdc+' <small>in Gateway</small>' : '<small>n/a</small>';
if (D.summary.testPayments) $('#c-settled').innerHTML += ' <small>+ '+D.summary.testPayments+' test</small>';

// AP judgements
const apRows = (D.ap||[]).slice().sort((a,b)=> (a.extracted.issueDate||'').localeCompare(b.extracted.issueDate||''));
$('#ap tbody').innerHTML = apRows.map(r => {
  const e=r.extracted, j=r.judgement;
  const act = j.action==='pay_now'?'allow':j.action==='hold'?'hold':j.action==='skip'?'deny':'hold';
  const label = {pay_now:'pay now',hold:'hold for human',skip:'skip (nothing due)',schedule:'schedule'}[j.action]||j.action;
  return '<tr><td class="mono">'+esc(e.invoiceId)+'<br><span class="sub">'+esc(e.issueDate)+'</span></td><td>'+esc(e.vendorName)+'<br><span class="sub">'+esc(e.description)+'</span></td><td class="mono">'+esc(e.currency)+' '+esc(e.amountDue)+(e.alreadyPaid?'<br><span class="sub">already paid</span>':'')+'</td><td><span class="pill '+act+'">'+label+'</span><br><span class="sub">confidence '+j.confidence+'</span></td><td class="reason">'+esc(j.reasoning)+(j.anomalies&&j.anomalies.length?'<br><span class="anom">⚠ '+j.anomalies.map(esc).join(' · ')+'</span>':'')+'</td><td class="mono">'+(r.usdc!=null?r.usdc+' USDC<br>':'')+(r.intentId?'<span class="sub">'+esc(r.intentId)+'</span>':r.skippedBecause?'<span class="sub">'+esc(r.skippedBecause)+'</span>':'')+'</td></tr>';
}).join('');

// ledger timeline
$('#ledger tbody').innerHTML = D.ledger.map(e => {
  const t = e.ts.replace('T',' ').slice(0,19);
  if (e.kind==='decision') {
    const d=e.decision;
    return '<tr><td>'+e.seq+'</td><td class="mono">'+t+'</td><td class="kind">decision</td><td class="mono">'+esc(d.intentId)+'</td><td>'+esc(d.vendorId||d.to||'')+' · <span class="mono">'+d.amount+' '+d.currency+'</span></td><td>'+pill(d.verdict)+'</td><td>'+(d.hits.length?d.hits.map(h=>'<span class="hit"><b>'+esc(h.rule)+'</b> → '+h.verdict+' — '+esc(h.detail)+'</span>').join(''):'<span class="hit">no rule hits</span>')+'</td></tr>';
  }
  if (e.kind==='execution') {
    const r=e.result;
    return '<tr><td>'+e.seq+'</td><td class="mono">'+t+'</td><td class="kind">execution</td><td class="mono">'+esc(r.intentId)+'</td><td></td><td>'+(r.ok?'<span class="pill allow">'+esc(r.state||'ok')+'</span> '+txlink(r.txHash):'<span class="pill deny">failed</span> '+esc(r.error||''))+'</td><td class="hit">'+(r.networkFee?'gas '+esc(r.networkFee)+' USDC':'')+'</td></tr>';
  }
  if (e.kind==='approval') {
    return '<tr><td>'+e.seq+'</td><td class="mono">'+t+'</td><td class="kind">approval</td><td class="mono">'+esc(e.intentId)+'</td><td></td><td><span class="pill hold">approved by '+esc(e.approver)+'</span></td><td class="hit">token '+esc(e.approvalToken)+(e.note?' — '+esc(e.note):'')+'</td></tr>';
  }
  return '';
}).join('');

// policy
$('#policy tbody').innerHTML = D.vendors.map(v => '<tr><td><b>'+esc(v.id)+'</b><br><span class="sub">'+esc(v.name)+'</span></td><td>'+esc(v.riskTier)+'</td><td class="mono">'+esc(JSON.stringify(v.caps))+'</td><td class="sub">'+esc(v.notes)+'</td></tr>').join('');
$('#global-caps').textContent = 'Global caps: '+JSON.stringify(D.caps)+(D.approvalThreshold!=null?' · human approval at ≥ '+D.approvalThreshold+' USDC':'')+' · unknown recipients are denied.';

// verify chain locally (same canonical JSON + sha256(prevHash + "\\n" + body) as src/ledger.ts)
function sortKeys(v){ if(Array.isArray(v)) return v.map(sortKeys); if(v&&typeof v==='object'){ return Object.keys(v).sort().reduce((a,k)=>{a[k]=sortKeys(v[k]);return a;},{}); } return v; }
async function sha256(s){ const b=new TextEncoder().encode(s); const h=await crypto.subtle.digest('SHA-256',b); return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
$('#verify').onclick = async () => {
  const out=$('#verify-out'); out.textContent='verifying…'; $('#verify').disabled=true;
  let prev='0'.repeat(64);
  for (const e of D.ledger) {
    const {hash, ...body} = e;
    if (body.prevHash!==prev) { out.innerHTML='<span class="bad">broken at seq '+e.seq+' (prevHash mismatch)</span>'; $('#verify').disabled=false; return; }
    const h = await sha256(prev+'\\n'+JSON.stringify(sortKeys(body)));
    if (h!==hash) { out.innerHTML='<span class="bad">broken at seq '+e.seq+' (hash mismatch — entry edited?)</span>'; $('#verify').disabled=false; return; }
    prev=hash;
  }
  out.innerHTML='<span class="ok">✓ '+D.ledger.length+' entries verified · head '+prev.slice(0,16)+'…</span>'; $('#verify').disabled=false;
};
</script></body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function generateReport(opts: { policyPath: string; ledgerPath: string; apDir: string; outPath: string; chain: string; treasury: string; repoUrl: string; now?: Date }): string {
  const policy = loadPolicy(opts.policyPath);
  const ledger = new Ledger(opts.ledgerPath);
  const apRecords = existsSync(opts.apDir) ? readdirSync(opts.apDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(opts.apDir, f), "utf8"))) : [];
  const html = renderHtml(buildReportData({ policy, ledger, apRecords, chain: opts.chain, treasury: opts.treasury, repoUrl: opts.repoUrl, generatedAt: (opts.now ?? new Date()).toISOString() }));
  mkdirSync(join(opts.outPath, ".."), { recursive: true });
  writeFileSync(opts.outPath, html);
  return html;
}

if (process.argv[1] && /report\.(ts|js)$/.test(process.argv[1])) {
  loadDotenv();
  const out = process.env.GUARDIAN_REPORT ?? "./docs/index.html";
  generateReport({
    policyPath: process.env.GUARDIAN_POLICY ?? "./policy.yaml",
    ledgerPath: process.env.GUARDIAN_LEDGER ?? "./data/guardian.ledger.jsonl",
    apDir: "./data/ap",
    outPath: out,
    chain: process.env.GUARDIAN_CHAIN ?? "ARC-TESTNET",
    treasury: process.env.GUARDIAN_TREASURY_ADDRESS ?? "",
    repoUrl: process.env.GUARDIAN_REPO_URL ?? "https://github.com/aa160999/arc-guardian",
  });
  console.log(`report written to ${out}`);
}
