import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, Ledger } from "../src/ledger.js";
import { parsePolicy } from "../src/policy.js";

describe("Ledger", () => {
  it("chains hashes and verifies", () => {
    const l = Ledger.inMemory();
    expect(l.headHash).toBe(GENESIS_HASH);
    l.append({ kind: "approval", intentId: "a", approvalToken: "t", approver: "ryan" });
    l.append({ kind: "approval", intentId: "b", approvalToken: "t2", approver: "ryan" });
    expect(l.length).toBe(2);
    expect(l.all()[1].prevHash).toBe(l.all()[0].hash);
    expect(l.verify()).toEqual({ ok: true });
  });

  it("persists to disk, reloads, and detects tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardian-"));
    const path = join(dir, "l.jsonl");
    const l = new Ledger(path);
    l.append({ kind: "approval", intentId: "a", approvalToken: "t", approver: "ryan" });
    l.append({ kind: "approval", intentId: "b", approvalToken: "t2", approver: "ryan" });

    const reloaded = new Ledger(path);
    expect(reloaded.length).toBe(2);
    expect(reloaded.verify()).toEqual({ ok: true });

    // edit line 1 in place
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]);
    e.approver = "mallory";
    lines[0] = JSON.stringify(e);
    writeFileSync(path, lines.join("\n") + "\n");
    const tampered = new Ledger(path);
    const r = tampered.verify();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.brokenAtSeq).toBe(1);
  });
});

describe("parsePolicy", () => {
  it("rejects duplicate vendor addresses", () => {
    expect(() =>
      parsePolicy(`
version: 1
business: x
vendors:
  - { id: a, name: A, address: "0x1111111111111111111111111111111111111111" }
  - { id: b, name: B, address: "0x1111111111111111111111111111111111111111" }
`),
    ).toThrow(/duplicate vendor address/);
  });

  it("rejects unknown keys (typos cannot silently disable a rule)", () => {
    expect(() => parsePolicy(`{ version: 1, business: x, approvalThreshhold: 5 }`)).toThrow(/invalid policy/);
  });
});

describe("Ledger — out-of-process appends", () => {
  it("reloads before appending so two writers never fork the chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardian-"));
    const path = join(dir, "l.jsonl");
    const a = new Ledger(path);
    const b = new Ledger(path);
    a.append({ kind: "approval", intentId: "x", approvalToken: "t1", approver: "a", bind: "h" });
    b.append({ kind: "approval", intentId: "y", approvalToken: "t2", approver: "b", bind: "h" }); // b loaded before a wrote
    const fresh = new Ledger(path);
    expect(fresh.length).toBe(2);
    expect(fresh.verify()).toEqual({ ok: true });
  });
});
