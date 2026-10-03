import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("CircleCliExecutor — EURC path (quote → swap → transfer --token)", () => {
  const EURC_DECISION: Decision = { ...DECISION, currency: "EURC", amount: 10 };
  it("sells a whole number of USDC with stop-limit = amount owed, then transfers EURC", async () => {
    // fake circle: records argv, answers quote / swap / transfer
    const dir = mkdtempSync(join(tmpdir(), "fake-circle-"));
    const log = join(dir, "argv.log");
    const bin = join(dir, "circle");
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *--quote*) echo '{"data":{"estimatedOutput":"0.822275","sellToken":"USDC","buyToken":"EURC"}}';;
  *"wallet swap"*) echo '{"data":{"transactions":[{"id":"ap","state":"COMPLETE","txHash":"0xaaaa"},{"id":"swap-1","state":"COMPLETE","txHash":"0x'$(printf 's%.0s' $(seq 1 63))'"}]}}';;
  *"wallet transfer"*) echo '{"data":{"id":"tr-1","state":"COMPLETE","txHash":"0x'$(printf 't%.0s' $(seq 1 63))'","networkFee":"0.03"}}';;
  *) echo '{}';;
esac
`,
    );
    chmodSync(bin, 0o755);
    const r = await new CircleCliExecutor(bin).execute(EURC_DECISION, { from: "0xfrom", chain: "ARC-TESTNET", now: new Date() });
    expect(r.ok).toBe(true);
    expect(r.swapTxHash).toMatch(/^0xs+$/);
    expect(r.txHash).toMatch(/^0xt+$/);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toContain("wallet swap USDC 1 EURC --chain ARC-TESTNET --quote");
    // 10 / 0.822275 * 1.1 = 13.37 → sell 14 USDC (whole number); stop-limit = 10 EURC; expected 11.51 → slippage ceil(1313.x)+100 = 1414 bps
    expect(calls[1]).toContain("wallet swap USDC 14 EURC 10 --address 0xfrom --chain ARC-TESTNET --slippage-bps 1414 --idempotency-key swap-t");
    expect(calls[2]).toContain("wallet transfer 0x081ffaab8d11f9cd8a9913aab76464602aac699d --amount 10 --address 0xfrom --chain ARC-TESTNET --output json --token 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
  });

  it("refuses a currency with no known contract on the chain", async () => {
    const bin = fakeCircle(`echo '{}'`);
    const r = await new CircleCliExecutor(bin).execute(EURC_DECISION, { from: "0x", chain: "ARC", now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no EURC contract/);
  });
});

describe("CircleCliExecutor — second review", () => {
  it("refuses chains other than Arc (USDC is only the native token there)", async () => {
    const bin = fakeCircle(`echo '{}'`);
    await expect(new CircleCliExecutor(bin).execute(DECISION, { from: "0x", chain: "BASE", now: new Date() })).rejects.toThrow(/ARC and ARC-TESTNET only/);
  });

  it("never lets a broken quote decide how much USDC to sell", async () => {
    const bin = fakeCircle(`case "$*" in *--quote*) echo '{"data":{"estimatedOutput":"0.0001"}}';; *) echo '{}';; esac`);
    const r = await new CircleCliExecutor(bin).execute({ ...DECISION, currency: "EURC", amount: 3.8 }, { from: "0x", chain: "ARC-TESTNET", now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of sane range/);
  });

  it("keeps the swap tx and marks UNKNOWN when the transfer step fails after a successful swap", async () => {
    const bin = fakeCircle(`case "$*" in
      *--quote*) echo '{"data":{"estimatedOutput":"0.82"}}';;
      *"wallet swap"*) echo '{"data":{"transactions":[{"id":"s","state":"COMPLETE","txHash":"0xswapswap"}]}}';;
      *"wallet transfer"*) echo 'Error: request timeout' 1>&2; exit 1;;
    esac`);
    const r = await new CircleCliExecutor(bin).execute({ ...DECISION, currency: "EURC", amount: 3 }, { from: "0x", chain: "ARC-TESTNET", now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.swapTxHash).toBe("0xswapswap");
    expect(r.state).toBe("UNKNOWN");
    expect(r.error).toMatch(/swap already executed/);
  });
});
