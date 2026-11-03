import { lstatSync, readdirSync, statSync } from "node:fs";
import { readRegular } from "./files.js";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { Plugin, PluginFormat, Project, Skill } from "./types.js";

export interface DiscoverOptions {
  /** Stop after looking at this many files and folders (default 20,000). */
  maxFiles?: number;
  /** Largest SKILL.md or manifest read, in bytes (default 1 MB). */
  maxBytes?: number;
}

const SKIP = new Set(["node_modules", ".git", ".hg", ".svn"]);
export const MAX_BYTES = 1_000_000;

/** Manifest paths, relative to a plugin root, and the format each one means. */
const MANIFESTS: [string, PluginFormat][] = [
  [".claude-plugin/plugin.json", "claude"],
  [".codex-plugin/plugin.json", "codex"],
  [".cursor-plugin/plugin.json", "cursor"],
  ["gemini-extension.json", "gemini"],
];

/** Which hosts load skills from a folder, judged by the path. Sources are in hosts/hosts.yaml. */
const LOCATIONS: [RegExp, string[]][] = [
  [/(^|\/)\.claude\/skills\//, ["claude"]],
  [/(^|\/)\.agents\/skills\//, ["codex", "cursor", "gemini"]],
  [/(^|\/)\.cursor\/skills\//, ["cursor"]],
  [/(^|\/)\.codex\/skills\//, ["cursor"]],
  [/(^|\/)\.gemini\/skills\//, ["gemini"]],
];
const PLUGIN_HOSTS: Record<PluginFormat, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  cursor: ["cursor"],
  agent: ["codex", "cursor"],
  gemini: ["gemini"],
};

export const posix = (p: string) => p.split(sep).join("/");

function readSmall(path: string, max: number): string {
  return readRegular(path, max).toString("utf8");
}

function readPlugin(root: string, dir: string, rel: string, format: PluginFormat, max: number): Plugin {
  const file = posix(relative(root, join(dir, rel))) || rel;
  try {
    const data = JSON.parse(readSmall(join(dir, rel), max));
    if (!data || typeof data !== "object" || Array.isArray(data)) return { dir, file, format, error: "The manifest is not a JSON object." };
    return { dir, file, format, manifest: data };
  } catch (e) {
    return { dir, file, format, error: `The manifest is not valid JSON: ${(e as Error).message}` };
  }
}

export function readSkill(root: string, path: string, max = MAX_BYTES): Skill {
  const dir = dirname(path);
  const file = posix(relative(root, path)) || basename(path);
  let raw = "";
  let readError: string | undefined;
  try { raw = readSmall(path, max); } catch (e) { readError = (e as Error).message; }
  const p = parseFrontmatter(raw.replace(/^\ufeff/, ""));
  const where = posix(dir) + "/";
  const hosts = [...new Set(LOCATIONS.filter(([re]) => re.test(where)).flatMap(([, h]) => h))];
  return {
    dir, file, dirName: basename(dir), raw,
    hasFrontmatter: readError ? true : p.hasFrontmatter,
    frontmatter: readError ? undefined : p.data,
    frontmatterError: readError ?? p.error,
    fieldLines: p.fieldLines, body: p.body, bodyLine: p.bodyLine, hosts,
  };
}

/**
 * Finds SKILL.md files and plugin manifests under a folder. Symbolic links are not followed,
 * so a hostile repo cannot point the search outside the folder or into a loop.
 */
export function discover(target: string, o: DiscoverOptions = {}): Project {
  const maxFiles = o.maxFiles ?? 20_000;
  const max = o.maxBytes ?? MAX_BYTES;
  const abs = resolve(target);
  const st = statSync(abs);
  if (st.isFile()) {
    const root = dirname(abs);
    if (basename(abs) === "SKILL.md") return { root, skills: [readSkill(root, abs, max)], plugins: [] };
    const m = MANIFESTS.find(([rel]) => abs.endsWith(sep + rel.split("/").join(sep)) || basename(abs) === rel);
    if (m) { const pr = abs.slice(0, abs.length - m[0].length - 1) || root; return discover(pr, o); }
    throw new Error(`${target} is not a SKILL.md, a plugin manifest or a folder.`);
  }
  const root = abs;
  const skills: Skill[] = [];
  const plugins: Plugin[] = [];
  let seen = 0;
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 12) return;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const [rel, format] of MANIFESTS) {
      const parts = rel.split("/");
      if (names.includes(parts[0])) {
        try { if (lstatSync(join(dir, rel)).isFile()) plugins.push(readPlugin(root, dir, rel, format, max)); } catch { /* not there */ }
      }
    }
    if (names.includes("plugin.json") && !/^\.(claude|codex|cursor)-plugin$/.test(basename(dir))) {
      // A portable Agent Plugin keeps plugin.json at the root and names the shared schema.
      const pj = readPlugin(root, dir, "plugin.json", "agent", max);
      if (pj.error || isAgentSchema(pj.manifest?.$schema)) plugins.push(pj);
    }
    for (const name of names) {
      if (++seen > maxFiles) { truncated = true; return; }
      const full = join(dir, name);
      let s;
      try { s = lstatSync(full); } catch { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) { if (!SKIP.has(name)) walk(full, depth + 1); }
      else if (name === "SKILL.md" && s.isFile()) skills.push(readSkill(root, full, max));
    }
  };
  walk(root, 0);
  // Skills inside a plugin's skills/ folder are loaded by that plugin's host.
  for (const s of skills) {
    const owner = plugins
      .filter((p) => s.dir.startsWith(join(p.dir, "skills") + sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner) {
      s.plugin = owner.file;
      const extra = plugins.filter((p) => p.dir === owner.dir).flatMap((p) => PLUGIN_HOSTS[p.format]);
      s.hosts = [...new Set([...s.hosts, ...extra])];
    }
  }
  return { root, skills, plugins, truncated };
}

/** True when a $schema URL is served from agent-plugins.org. */
export function isAgentSchema(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const h = new URL(v).hostname;
    return h === "agent-plugins.org" || h.endsWith(".agent-plugins.org");
  } catch {
    return false;
  }
}
