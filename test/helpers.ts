import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { clearFileCache } from "../src/files.js";

/** Writes files into a fresh temporary folder and returns its path. Paths ending in * are made executable. */
export function tree(files: Record<string, string>): string {
  clearFileCache();
  const root = mkdtempSync(join(tmpdir(), "skillmedic-"));
  for (const [rel, text] of Object.entries(files)) {
    const exec = rel.endsWith("*");
    const p = join(root, exec ? rel.slice(0, -1) : rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    if (exec) chmodSync(p, 0o755);
  }
  return root;
}

export const skill = (name: string, description: string, body = "Do the thing.\n", extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;

export const GOOD_DESC = "Formats spreadsheets and fixes broken formulas. Use when the user mentions Excel or CSV files.";

export function capture() {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => { out.push(String(s)); });
  vi.spyOn(console, "error").mockImplementation((s: unknown) => { out.push(String(s)); });
  return out;
}
