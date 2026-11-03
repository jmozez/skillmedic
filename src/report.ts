import { relative } from "node:path";
import { printable as p } from "./sanitize.js";
import { estimateTokens } from "./text.js";
import { skillName } from "./rules/index.js";
import type { Finding, Project, Severity } from "./types.js";

export interface SkillSummary {
  name: string;
  file: string;
  /** Hosts that load it from where it sits. Empty means any host it is copied into. */
  hosts: string[];
  /** Tokens the name and description cost in every conversation. */
  listingTokens: number;
  /** Tokens the body costs once the skill loads. */
  bodyTokens: number;
}

export interface Report {
  tool: "skillmedic";
  version: string;
  root: string;
  summary: { skills: number; plugins: number; listingTokens: number; errors: number; warnings: number; infos: number; score: number };
  skills: SkillSummary[];
  plugins: { name?: string; file: string; format: string }[];
  findings: Finding[];
  /** Version of the host rule pack used, if any. */
  hostPack?: string;
  /** True when the file limit stopped the search early. */
  truncated?: boolean;
}

const WEIGHT: Record<Severity, number> = { error: 10, warning: 3, info: 0 };

/** 100 minus a penalty per finding, scaled by the number of skills and plugins, floored at 0. Host rules do not count. */
export function score(findings: Finding[], items: number): number {
  const penalty = findings.reduce((n, f) => n + WEIGHT[f.severity], 0);
  return Math.max(0, Math.round(100 - (penalty / Math.max(1, items)) * 5));
}

export function buildReport(project: Project, findings: Finding[], version: string, cwd = process.cwd()): Report {
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const skills = project.skills.map((s) => {
    const fm = s.frontmatter ?? {};
    const listing = [skillName(s), typeof fm.description === "string" ? fm.description : "", typeof fm.when_to_use === "string" ? fm.when_to_use : ""].join(" ");
    return { name: skillName(s), file: s.file, hosts: s.hosts, listingTokens: estimateTokens(listing), bodyTokens: estimateTokens(s.body) };
  });
  const plugins = project.plugins.map((x) => ({ name: typeof x.manifest?.name === "string" ? x.manifest.name : undefined, file: x.file, format: x.format }));
  return {
    tool: "skillmedic",
    version,
    root: relative(cwd, project.root) || ".",
    summary: {
      skills: skills.length,
      plugins: plugins.length,
      listingTokens: skills.reduce((n, s) => n + s.listingTokens, 0),
      errors: count("error"),
      warnings: count("warning"),
      infos: count("info"),
      score: score(findings.filter((f) => !f.host), skills.length + plugins.length),
    },
    skills,
    plugins,
    findings,
    ...(project.truncated ? { truncated: true } : {}),
  };
}

export function formatText(r: Report, color = false): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark: Record<Severity, string> = { error: c("31", "error"), warning: c("33", "warn "), info: c("36", "info ") };
  const lines: string[] = [];
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  lines.push(c("1", `skillmedic ${r.version}: ${p(r.root)}`));
  lines.push(`${n(r.summary.skills, "skill")}, ${n(r.summary.plugins, "plugin")}, about ${r.summary.listingTokens} tokens of skill listings in every conversation`);
  if (r.truncated) lines.push(c("33", "Stopped early at the file limit, so some skills may be missing. Raise it with --max-files."));
  lines.push("");
  for (const f of r.findings) {
    const where = p([f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "", f.host ? `[${f.host}]` : ""].filter(Boolean).join(" "));
    lines.push(`  ${mark[f.severity]}  ${f.rule.padEnd(24)} ${where}`);
    lines.push(`         ${" ".repeat(24)} ${p(f.message)}`);
    if (f.fix) lines.push(`         ${" ".repeat(24)} ${c("32", "fix:")} ${p(f.fix)}`);
  }
  if (r.findings.length) lines.push("");
  const top = [...r.skills].sort((a, b) => b.bodyTokens - a.bodyTokens).slice(0, 5).map((s) => `${p(s.name)} (${s.bodyTokens})`).join(", ");
  if (top) lines.push(`Largest skills when loaded: ${top}`);
  lines.push(c("1", `Score ${r.summary.score}/100: ${n(r.summary.errors, "error")}, ${n(r.summary.warnings, "warning")}, ${n(r.summary.infos, "note")}`));
  return lines.join("\n");
}
