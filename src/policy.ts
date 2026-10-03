import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Policy, type Vendor } from "./types.js";

/** Stable JSON (sorted keys) so hashes are reproducible across runs. */
export function canonicalJson(value: unknown): string {
  // Round-trip first so what we hash is exactly what a reader will parse back (Dates → strings, undefined dropped, -0 → 0).
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function policyHash(policy: Policy): string {
  return sha256(canonicalJson(policy));
}

export function parsePolicy(text: string): Policy {
  const raw = parseYaml(text);
  const res = Policy.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid policy: ${msg}`);
  }
  const ids = new Set<string>();
  const addrs = new Set<string>();
  for (const v of res.data.vendors) {
    if (ids.has(v.id)) throw new Error(`invalid policy: duplicate vendor id ${v.id}`);
    const a = v.address.toLowerCase();
    if (addrs.has(a)) throw new Error(`invalid policy: duplicate vendor address ${v.address}`);
    ids.add(v.id);
    addrs.add(a);
  }
  return res.data;
}

export function loadPolicy(path: string): Policy {
  return parsePolicy(readFileSync(path, "utf8"));
}

export function findVendor(policy: Policy, opts: { vendorId?: string; to?: string }): Vendor | undefined {
  if (opts.vendorId) return policy.vendors.find((v) => v.id === opts.vendorId);
  if (opts.to) {
    const t = opts.to.toLowerCase();
    return policy.vendors.find((v) => v.address.toLowerCase() === t);
  }
  return undefined;
}
