import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAllowlist, makeRunnerDirs, processCommandsOnce, resolveCommand, type CmdSpec } from "../src/runner.js";

const ALLOW: Record<string, CmdSpec> = {
  echo: { argv: ["echo", "$1"], args: 1, description: "echo" },
  fail: { argv: ["sh", "-c", "exit 3"], description: "fails" },
  "no-args": { argv: ["true"], description: "no args" },
};

function old(p: string) {
  const t = new Date(Date.now() - 10_000);
  utimesSync(p, t, t);
}

describe("runner", () => {
  it("resolves allow-listed commands and substitutes validated args", () => {
    expect(resolveCommand(ALLOW, { run: "echo", args: ["hello world"] }).argv).toEqual(["echo", "hello world"]);
  });

  it("refuses unknown commands, wrong arity, and hostile args", () => {
    expect(() => resolveCommand(ALLOW, { run: "rm-rf" })).toThrow(/not allowed/);
    expect(() => resolveCommand(ALLOW, { run: "echo" })).toThrow(/exactly 1/);
    expect(() => resolveCommand(ALLOW, { run: "no-args", args: ["x"] })).toThrow(/exactly 0/);
    expect(() => resolveCommand(ALLOW, { run: "echo", args: ["$(id)"] })).toThrow(/rejected/);
    expect(() => resolveCommand(ALLOW, { run: "echo", args: ["a`b"] })).toThrow(/rejected/);
    expect(() => resolveCommand(ALLOW, { run: "echo", args: ["x".repeat(401)] })).toThrow(/rejected/);
    expect(() => resolveCommand(ALLOW, { run: "echo", args: [42] })).toThrow(/rejected/);
  });

  it("never invokes a shell: metacharacters in args are passed literally", async () => {
    const root = mkdtempSync(join(tmpdir(), "gr-"));
    const dirs = makeRunnerDirs(root);
    const p = join(dirs.cmd, "e.json");
    writeFileSync(p, JSON.stringify({ run: "echo", args: ["a && b (c) *"] })); // '&', '(' and '*' pass the validator; a shell would mangle them
    old(p);
    await processCommandsOnce(dirs, ALLOW, root);
    const r = JSON.parse(readFileSync(join(dirs.results, "e.json"), "utf8"));
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("a && b (c) *");
    expect(existsSync(join(dirs.done, "e.json"))).toBe(true);
  });

  it("records non-zero exits and validator errors as failed results", async () => {
    const root = mkdtempSync(join(tmpdir(), "gr-"));
    const dirs = makeRunnerDirs(root);
    for (const [n, body] of [
      ["f", { run: "fail" }],
      ["bad", { run: "nope" }],
    ] as const) {
      const p = join(dirs.cmd, `${n}.json`);
      writeFileSync(p, JSON.stringify(body));
      old(p);
    }
    const handled = await processCommandsOnce(dirs, ALLOW, root);
    expect(handled).toEqual(["bad", "f"]);
    const f = JSON.parse(readFileSync(join(dirs.results, "f.json"), "utf8"));
    expect(f.ok).toBe(false);
    expect(f.exitCode).toBe(3);
    const bad = JSON.parse(readFileSync(join(dirs.results, "bad.json"), "utf8"));
    expect(bad.error).toMatch(/not allowed/);
    expect(existsSync(join(dirs.failed, "bad.json"))).toBe(true);
  });

  it("default allowlist contains no shell and no interactive logins", () => {
    const allow = defaultAllowlist({ GUARDIAN_TREASURY_ADDRESS: "0xabc", GUARDIAN_CHAIN: "ARC-TESTNET" });
    for (const [name, spec] of Object.entries(allow)) {
      expect(spec.argv[0], name).not.toMatch(/^(sh|bash|zsh|node|python3?)$/);
      expect(spec.argv.join(" "), name).not.toMatch(/login|transfer|pay /);
    }
    expect(allow["circle-balance"].argv).toContain("0xabc");
  });
});
