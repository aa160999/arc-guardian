import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CircleCliExecutor, explorerTxUrl } from "../src/executors.js";
import type { Decision } from "../src/types.js";

/** Verbatim `circle wallet transfer --output json` output from Arc testnet, 2026-09-27. */
const REAL_OUTPUT = {
  data: {
    idempotencyKey: "dc747904-2945-47d6-b10f-8df40d5e9fcc",
    id: "ca58c85a-078a-5b7a-9014-4b878d1ed31f",
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash: "0x0f13e232762a0844cec750c173517b109ae775b2cef1b6d12a7cd5181733c216",
    sourceAddress: "0xdaba13b76272bd9c34dc24ca54f9e64b1c856f69",
    destinationAddress: "0x081ffaab8d11f9cd8a9913aab76464602aac699d",
    amounts: ["1.5"],
    networkFee: "0.03547165091625",
    operation: "TRANSFER",
    transactionType: "OUTBOUND",
    abiParameters: null,
    blockHash: "0x2edc08abaee8adea2ce93b6b11e4e66f5c927f848619b4afeda8e3b30fbedaf3",
    blockHeight: 64285063,
    firstConfirmDate: "2026-09-27T14:42:27Z",
    createDate: "2026-09-27T14:42:23Z",
    updateDate: "2026-09-27T14:42:27Z",
  },
};

const DECISION: Decision = {
  intentId: "t",
  verdict: "allow",
  to: "0x081ffaab8d11f9cd8a9913aab76464602aac699d",
  vendorId: "anthropic",
  amount: 1.5,
  currency: "USDC",
  hits: [],
  budgets: [],
  policyHash: "x",
  evaluatedAt: "2026-09-27T14:42:19.766Z",
};

function fakeCircle(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-circle-"));
  const bin = join(dir, "circle");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("CircleCliExecutor", () => {
  it("parses the real CLI shape: txHash, id, state, fee, explorer link", async () => {
    const bin = fakeCircle(`echo '${JSON.stringify(REAL_OUTPUT)}'`);
    const r = await new CircleCliExecutor(bin).execute(DECISION, { from: "0xdaba13b76272bd9c34dc24ca54f9e64b1c856f69", chain: "ARC-TESTNET", now: new Date("2026-09-27T14:42:19Z") });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe(REAL_OUTPUT.data.txHash);
    expect(r.providerId).toBe(REAL_OUTPUT.data.id);
    expect(r.state).toBe("COMPLETE");
    expect(r.networkFee).toBe("0.03547165091625");
    expect(r.confirmedAt).toBe("2026-09-27T14:42:27Z");
    expect(r.explorerUrl).toBe("https://explorer.testnet.arc.io/tx/" + REAL_OUTPUT.data.txHash);
  });

  it("treats a non-terminal or failed state as not ok, keeping raw", async () => {
    const failed = { data: { ...REAL_OUTPUT.data, state: "FAILED", txHash: undefined } };
    const bin = fakeCircle(`echo '${JSON.stringify(failed)}'`);
    const r = await new CircleCliExecutor(bin).execute(DECISION, { from: "0x", chain: "ARC-TESTNET", now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/FAILED/);
    expect(r.raw).toBeTruthy();
  });

  it("captures a non-zero exit as an error instead of throwing", async () => {
    const bin = fakeCircle(`echo 'Error: session expired, run circle wallet login' 1>&2; exit 1`);
    const r = await new CircleCliExecutor(bin).execute(DECISION, { from: "0x", chain: "ARC-TESTNET", now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/session expired/);
  });

  it("refuses to execute anything but an allow", async () => {
    const bin = fakeCircle(`echo '{}'`);
    await expect(new CircleCliExecutor(bin).execute({ ...DECISION, verdict: "hold" }, { from: "0x", chain: "ARC-TESTNET", now: new Date() })).rejects.toThrow(/non-allow/);
  });

  it("explorer url only for known chains", () => {
    expect(explorerTxUrl("ARC", "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(explorerTxUrl("BASE", "0xabc")).toBeUndefined();
  });
});
