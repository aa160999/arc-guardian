import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DryRunExecutor } from "../src/executors.js";
import { Guardian } from "../src/guardian.js";
import { Ledger } from "../src/ledger.js";
import { parsePolicy } from "../src/policy.js";
import { makeDirs, processQueueOnce } from "../src/worker.js";

const POLICY = parsePolicy(`
version: 1
business: t
caps: { perTx: 100 }
vendors:
  - { id: v, name: V, address: "0x1111111111111111111111111111111111111111" }
`);

function old(path: string) {
  const t = new Date(Date.now() - 10_000);
  utimesSync(path, t, t);
}

describe("worker", () => {
  it("pays settled intents, writes results, moves inputs; skips files still being written", async () => {
    const root = mkdtempSync(join(tmpdir(), "gw-"));
    const dirs = makeDirs(root);
    const g = new Guardian({ policy: POLICY, ledger: Ledger.inMemory(), executor: new DryRunExecutor(), from: "0xt", chain: "ARC-TESTNET" });

    const ok = join(dirs.queue, "a-ok.json");
    writeFileSync(ok, JSON.stringify({ intentId: "a", vendorId: "v", amount: 10, reason: "r" }));
    old(ok);
    const bad = join(dirs.queue, "b-bad.json");
    writeFileSync(bad, "{ not json");
    old(bad);
    const fresh = join(dirs.queue, "c-fresh.json");
    writeFileSync(fresh, JSON.stringify({ intentId: "c", vendorId: "v", amount: 10, reason: "r" })); // mtime = now → skipped

    const handled = await processQueueOnce(dirs, g);
    expect(handled).toEqual(["a-ok", "b-bad"]);

    const r = JSON.parse(readFileSync(join(dirs.results, "a-ok.json"), "utf8"));
    expect(r.decision.verdict).toBe("allow");
    expect(r.execution.ok).toBe(true);
    expect(existsSync(join(dirs.done, "a-ok.json"))).toBe(true);

    const e = JSON.parse(readFileSync(join(dirs.results, "b-bad.json"), "utf8"));
    expect(e.error).toMatch(/JSON/);
    expect(existsSync(join(dirs.failed, "b-bad.json"))).toBe(true);

    expect(existsSync(fresh)).toBe(true); // untouched
    const later = await processQueueOnce(dirs, g, { now: () => Date.now() + 5000 });
    expect(later).toEqual(["c-fresh"]);
  });
});
