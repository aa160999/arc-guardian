import { lstatSync } from "node:fs";

/** Regular files only (no symlinks, no directories), small, and not modified in the last `settleMs`. */
export function regularFile(p: string, nowMs: number, settleMs: number, maxBytes = 256 * 1024): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() && st.size <= maxBytes && nowMs - st.mtimeMs >= settleMs;
  } catch {
    return false;
  }
}

