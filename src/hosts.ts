import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { skillName } from "./rules/index.js";
import type { Finding, Project, Rule, Severity, Skill } from "./types.js";

export type HostCheck =
  | { type: "listing-length"; max: number; fields: string[] }
  | { type: "reserved-folder"; names: string[] }
  | { type: "name-characters" }
  | { type: "name-reserved"; words: string[] }
  | { type: "no-xml"; fields: string[] }
  | { type: "allowed-fields"; fields: string[] }
  | { type: "listing-budget"; max: number }
  | { type: "name-required"; pattern: string }
  | { type: "legacy-field"; field: string; use: string }
  | { type: "shadowed"; winner: string; loser: string };

export interface HostRule {
  id: string;
  host: string;
  severity: Severity;
  summary: string;
  check: HostCheck;
  /** False means the rule runs only when its host is named with --host. */
  default?: boolean;
  fix?: string;
  source: string;
  quote: string;
  checked: string;
}

export interface HostPack {
  version: string;
  hosts: Record<string, string>;
  rules: HostRule[];
}

const PACK_PATH = fileURLToPath(new URL("../hosts/hosts.yaml", import.meta.url));
const TYPES = new Set(["listing-length", "reserved-folder", "name-characters", "name-reserved", "no-xml", "allowed-fields", "listing-budget", "name-required", "legacy-field", "shadowed"]);

export function loadHostPack(path = PACK_PATH): HostPack {
  const pack = parse(readFileSync(path, "utf8"), { maxAliasCount: 50 }) as HostPack;
  pack.version = String(pack.version);
  for (const r of pack.rules) {
    if (!pack.hosts[r.host]) throw new Error(`Host rule ${r.id} names an unknown host "${r.host}".`);
    if (!r.source?.startsWith("https://")) throw new Error(`Host rule ${r.id} has no source link.`);
    if (!TYPES.has(r.check?.type)) throw new Error(`Host rule ${r.id} has an unknown check type.`);
  }
  return pack;
}

/** The skill locations a host reads: claude-code and claude-api both count as claude. */
const family = (host: string) => host.split("-")[0];
const applies = (s: Skill, host: string) => !s.hosts.length || s.hosts.includes(family(host));
const str = (v: unknown) => (typeof v === "string" ? v : "");
// Control, zero-width, bidi, private-use, angle brackets, no-break and other odd blanks, double or edge spaces.
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ue000-\uf8ff<>\u00a0\u2000-\u200a\u3000]|\s{2}|^\s|\s$/u;

type Hit = { skill?: Skill; file?: string; line?: number; message: string };

function evaluate(c: HostCheck, p: Project, host: string): Hit[] {
  const skills = p.skills.filter((s) => applies(s, host));
  const each = (fn: (s: Skill, fm: Record<string, unknown>) => Omit<Hit, "skill"> | undefined) =>
    skills.flatMap((s) => { const h = s.frontmatter ? fn(s, s.frontmatter) : undefined; return h ? [{ skill: s, ...h }] : []; });
  switch (c.type) {
    case "listing-length":
      return each((s, fm) => {
        const n = c.fields.map((f) => str(fm[f])).filter(Boolean).join(" ").length;
        return n > c.max ? { line: s.fieldLines.description, message: `The listing text is ${n} characters, so everything after ${c.max} is cut.` } : undefined;
      });
    case "reserved-folder":
      return skills.flatMap((s) => {
        const d = s.dirName.toLowerCase();
        return c.names.some((n) => d === n || d.startsWith(`${n}:`)) ? [{ skill: s, message: `The folder name ${s.dirName} is reserved, so the skill does not load.` }] : [];
      });
    case "name-characters":
      return each((s, fm) => typeof fm.name === "string" && BAD_NAME.test(fm.name)
        ? { line: s.fieldLines.name, message: "The name has a character the host refuses, so the skill cannot be invoked by it." } : undefined);
    case "name-reserved":
      return each((s, fm) => {
        const w = c.words.find((x) => str(fm.name).toLowerCase().includes(x));
        return w ? { line: s.fieldLines.name, message: `The name contains the reserved word "${w}".` } : undefined;
      });
    case "no-xml":
      return each((s, fm) => {
        const f = c.fields.find((x) => /<\/?[A-Za-z][\w:-]*(\s[^<>]*)?\/?>/.test(str(fm[x])));
        return f ? { line: s.fieldLines[f], message: `The ${f} contains an XML tag.` } : undefined;
      });
    case "allowed-fields":
      return each((s, fm) => {
        const extra = Object.keys(fm).filter((k) => !c.fields.includes(k));
        return extra.length ? { line: s.fieldLines[extra[0]], message: `Upload fails on ${extra.join(", ")}.` } : undefined;
      });
    case "listing-budget": {
      const total = skills.reduce((n, s) => n + skillName(s).length + str(s.frontmatter?.description).length + s.file.length, 0);
      return total > c.max ? [{ message: `${skills.length} skills use about ${total} characters of names, descriptions and paths, over ${c.max}.` }] : [];
    }
    case "name-required":
      return skills.flatMap((s) => {
        if (!s.frontmatter) return [];
        const n = s.frontmatter.name;
        if (typeof n !== "string" || !n) return [{ skill: s, line: 1, message: "The skill has no name, which this host requires." }];
        return new RegExp(c.pattern).test(n) ? [] : [{ skill: s, line: s.fieldLines.name, message: `The name ${n} has characters this host does not allow.` }];
      });
    case "legacy-field":
      return each((s, fm) => c.field in fm ? { line: s.fieldLines[c.field], message: `${c.field} is a legacy field. Use ${c.use}.` } : undefined);
    case "shadowed": {
      const at = (s: Skill, part: string) => (`/${s.file}`).includes(part);
      const win = new Map(skills.filter((s) => at(s, c.winner)).map((s) => [skillName(s), s]));
      return skills.filter((s) => at(s, c.loser) && win.has(skillName(s))).map((s) => ({
        skill: s, message: `${win.get(skillName(s))!.file} has the same name and is used instead, so this skill never loads.`,
      }));
    }
  }
}

/** Turns host rules into ordinary rules. Each finding names the host and links the source. */
export function hostRules(pack: HostPack, hosts?: string[]): Rule[] {
  return pack.rules
    .filter((r) => (hosts?.length ? hosts.includes(r.host) : r.default !== false))
    .map((r) => ({
      id: r.id,
      severity: r.severity,
      summary: `${r.summary.replace(/\.$/, "")} (${pack.hosts[r.host]}).`,
      source: r.source,
      check: (p: Project): Finding[] => evaluate(r.check, p, r.host).map(({ skill, ...h }) => ({
        rule: r.id,
        severity: r.severity,
        ...(skill ? { skill: skillName(skill), file: skill.file } : {}),
        ...h,
        message: `[${r.host}] ${h.message}`,
        ...(r.fix ? { fix: r.fix } : {}),
        source: r.source,
        host: r.host,
      })),
    }));
}
