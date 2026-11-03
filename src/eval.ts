import { printable } from "./sanitize.js";
import { skillName } from "./rules/index.js";
import type { Project } from "./types.js";
import { readRegular } from "./files.js";
import { parse } from "yaml";
import type { Choice, Listing, Provider } from "./providers.js";


export interface EvalCase {
  prompt: string;
  /** Skill names that count as right. An empty list means the model should not load a skill. */
  expect: string[];
}

export interface EvalSuite {
  system?: string;
  cases: EvalCase[];
}

export interface CaseResult {
  prompt: string;
  expect: string[];
  runs: Array<Choice & { correct: boolean; error?: string }>;
  correct: number;
  /** Every run picked the same skill. */
  consistent: boolean;
  /** The skill picked most often, or null for no skill. */
  usual: string | null;
}

export interface EvalResult {
  model: string;
  repeat: number;
  cases: CaseResult[];
  summary: {
    runs: number;
    errors: number;
    /** Share of all runs that picked a right skill, 0 to 1. */
    accuracy: number;
    /** Share of cases where every run picked the same skill. */
    consistency: number;
    /** Skills that were picked when another was expected: wrong skill to count. */
    confusions: Array<{ expected: string; picked: string; count: number }>;
  };
}

/** Keeps a mistaken or hostile cases file from running up a large model bill. */
export const MAX_CASES = 1000;

const NONE = new Set(["none", "no skill", "null", "~", ""]);

/** Reads cases from YAML or JSON: either { system, cases: [...] } or a bare list. */
export function parseSuite(text: string, where = "cases file"): EvalSuite {
  let data;
  try { data = parse(text, { maxAliasCount: 100 }); } catch (e) { throw new Error(`${where} is not valid YAML: ${(e as Error).message.split("\n")[0]}`); }
  const list = Array.isArray(data) ? data : data?.cases;
  if (!Array.isArray(list) || !list.length) throw new Error(`${where} has no cases. Give a list of { prompt, expect }.`);
  if (list.length > MAX_CASES) throw new Error(`${where} has ${list.length} cases. The limit is ${MAX_CASES}.`);
  const cases = list.map((c: any, i: number): EvalCase => {
    if (!c || typeof c.prompt !== "string" || !c.prompt.trim()) throw new Error(`Case ${i + 1} in ${where} needs a prompt.`);
    if (!("expect" in c)) throw new Error(`Case ${i + 1} in ${where} needs expect: a skill name, a list of names, or none.`);
    const raw = c.expect === null ? [] : Array.isArray(c.expect) ? c.expect : [c.expect];
    const expect = raw.map(String).filter((x: string) => !NONE.has(x.toLowerCase()));
    return { prompt: c.prompt, expect };
  });
  return { system: typeof data?.system === "string" ? data.system : undefined, cases };
}

export function loadSuite(path: string): EvalSuite {
  return parseSuite(readRegular(path, 5_000_000).toString("utf8"), path);
}

export function isCorrect(c: EvalCase, choice: Choice): boolean {
  if (!c.expect.length) return choice.skill === null;
  return choice.skill !== null && c.expect.includes(choice.skill);
}

async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

export interface EvalOptions {
  repeat?: number;
  concurrency?: number;
}

/** Names in expect that are not among the skills, which usually means a typo in the cases file. */
export function unknownExpected(suite: EvalSuite, skills: Listing[]): string[] {
  const names = new Set(skills.map((s) => s.name));
  return [...new Set(suite.cases.flatMap((c) => c.expect).filter((n) => !names.has(n)))];
}

export async function runEval(provider: Provider, skills: Listing[], suite: EvalSuite, o: EvalOptions = {}): Promise<EvalResult> {
  const repeat = Math.max(1, o.repeat ?? 3);
  const jobs = suite.cases.flatMap((c) => Array.from({ length: repeat }, () => async () => {
    try {
      const choice = await provider.choose({ system: suite.system, prompt: c.prompt, skills });
      return { ...choice, correct: isCorrect(c, choice) };
    } catch (e) {
      return { skill: null, correct: false, error: (e as Error).message };
    }
  }));
  const flat = await pool(jobs, o.concurrency ?? 4);
  const confusion = new Map<string, number>();
  const cases = suite.cases.map((c, i): CaseResult => {
    const runs = flat.slice(i * repeat, (i + 1) * repeat);
    const counts = new Map<string | null, number>();
    for (const r of runs) if (!r.error) counts.set(r.skill, (counts.get(r.skill) ?? 0) + 1);
    let usual: string | null = null;
    let most = 0;
    for (const [t, n] of counts) if (n > most) { usual = t; most = n; }
    for (const r of runs) {
      if (r.correct || r.error) continue;
      const key = `${c.expect[0] ?? "(no skill)"}\u0000${r.skill ?? "(no skill)"}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
    return { prompt: c.prompt, expect: c.expect, runs, correct: runs.filter((r) => r.correct).length, consistent: counts.size === 1 && most === runs.length, usual };
  });
  const total = flat.length;
  return {
    model: provider.id,
    repeat,
    cases,
    summary: {
      runs: total,
      errors: flat.filter((r) => r.error).length,
      accuracy: total ? flat.filter((r) => r.correct).length / total : 0,
      consistency: cases.length ? cases.filter((c) => c.consistent).length / cases.length : 0,
      confusions: [...confusion].map(([k, count]) => { const [expected, picked] = k.split("\u0000"); return { expected, picked, count }; })
        .sort((a, b) => b.count - a.count),
    },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatEval(r: EvalResult): string {
  return printable(formatEvalRaw(r));
}

function formatEvalRaw(r: EvalResult): string {
  const s = r.summary;
  const lines = [
    `skillmedic eval with ${r.model}: ${r.cases.length} cases, ${r.repeat} runs each`,
    `Accuracy ${pct(s.accuracy)}, consistency ${pct(s.consistency)}${s.errors ? `, ${s.errors} runs failed` : ""}`,
    "",
  ];
  for (const c of r.cases) {
    const mark = c.correct === c.runs.length ? "pass" : c.correct === 0 ? "FAIL" : "flaky";
    const want = c.expect.length ? c.expect.join(" or ") : "no skill";
    lines.push(`  ${mark.padEnd(6)} ${c.correct}/${c.runs.length}  ${c.prompt}`);
    if (mark !== "pass") {
      const picked = [...new Set(c.runs.map((x) => x.error ? `error: ${x.error.slice(0, 80)}` : x.skill ?? "no skill"))].join(", ");
      lines.push(`                expected ${want}, got ${picked}`);
    }
  }
  if (s.confusions.length) {
    lines.push("", "Most common mix-ups (expected, then picked):");
    for (const c of s.confusions.slice(0, 5)) lines.push(`  ${c.expected} -> ${c.picked}  (${c.count})`);
    lines.push("", "Tip: make the descriptions of mixed-up skills say when to use each one, and when not to. skillmedic fix can try rewrites for you.");
  }
  return lines.join("\n");
}

/** The listing each skill shows the model: name, description and when_to_use, first copy of each name only. */
export function listings(project: Project): Listing[] {
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const s of project.skills) {
    const name = skillName(s);
    if (seen.has(name)) continue;
    seen.add(name);
    const fm = s.frontmatter ?? {};
    const parts = [fm.description, fm.when_to_use].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    out.push({ name, description: parts.join(" ") });
  }
  return out;
}
