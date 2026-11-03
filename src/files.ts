import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { posix } from "./discover.js";

export interface SkillFile {
  path: string;
  /** Relative to the skill folder, with forward slashes. */
  rel: string;
  size: number;
  mode: number;
}

const cache = new Map<string, SkillFile[]>();

/** Every regular file in a skill folder, without following links, up to a limit. */
export function listFiles(dir: string, limit = 500): SkillFile[] {
  const hit = cache.get(dir);
  if (hit) return hit;
  const out: SkillFile[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8 || out.length >= limit) return;
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= limit) return;
      if (n === "node_modules" || n === ".git") continue;
      const full = join(d, n);
      let s;
      try { s = lstatSync(full); } catch { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) walk(full, depth + 1);
      else if (s.isFile()) out.push({ path: full, rel: posix(relative(dir, full)), size: s.size, mode: s.mode });
    }
  };
  walk(dir, 0);
  cache.set(dir, out);
  return out;
}

/** Text of a file, or undefined when it is too big or looks binary. */
export function readText(f: SkillFile, max = 1_000_000): string | undefined {
  if (f.size > max) return undefined;
  let buf: Buffer;
  try { buf = readRegular(f.path, max); } catch { return undefined; }
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return buf.toString("utf8");
}

export function clearFileCache() { cache.clear(); }

/**
 * Reads a regular file through one file handle, so a swap between the check and the read
 * cannot point it at a link, a FIFO or a bigger file. Throws with a plain message otherwise.
 */
export function readRegular(path: string, max: number): Buffer {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file.`);
    if (st.size > max) throw new Error(`The file is ${st.size.toLocaleString("en-NZ")} bytes, over the ${max.toLocaleString("en-NZ")} byte limit.`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
