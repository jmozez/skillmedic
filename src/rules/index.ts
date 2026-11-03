import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { posix } from "../discover.js";
import { listFiles, readText } from "../files.js";
import { CREDENTIAL_FILES, findSecrets, REMOTE_CODE, RISKY_COMMAND, SUSPICIOUS } from "../security.js";
import { describeChar, estimateTokens, HIDDEN, lineOf } from "../text.js";
import type { Finding, Project, Rule, Severity, Skill } from "../types.js";

export const SPEC = "https://agentskills.io/specification";
export const CLAUDE = "https://code.claude.com/docs/en/skills";
export const BEST = "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices";

/** Frontmatter fields documented by the Agent Skills spec or by at least one host. */
export const KNOWN_FIELDS = new Set([
  // Agent Skills specification
  "name", "description", "license", "compatibility", "metadata", "allowed-tools",
  // Claude Code
  "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable", "disallowed-tools",
  "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
  // Cursor
  "icon", "color",
]);

type Hit = Omit<Finding, "rule" | "severity" | "skill" | "file"> & { file?: string };

export const skillName = (s: Skill) => (typeof s.frontmatter?.name === "string" && s.frontmatter.name ? s.frontmatter.name : s.dirName);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function make(id: string, severity: Severity, summary: string, source: string | undefined, fn: (s: Skill, p: Project) => Hit[]): Rule {
  return {
    id, severity, summary, source,
    check: (p) => p.skills.flatMap((s) => fn(s, p).map((h) => ({
      rule: id, severity, skill: skillName(s), file: h.file ?? s.file, ...(source ? { source } : {}), ...h,
    }))),
  };
}

/** Rules that need parsed frontmatter skip skills whose frontmatter is missing or broken: one finding is enough. */
const parsed = (fn: (s: Skill, fm: Record<string, unknown>, p: Project) => Hit[]) => (s: Skill, p: Project) =>
  s.frontmatter ? fn(s, s.frontmatter, p) : [];

const fieldLine = (s: Skill, key: string) => (s.fieldLines[key] ? s.fieldLines[key] + 0 : undefined);

const VAGUE = /^\s*(helps?( with)?|handles?|manages?|deals with|utilit(y|ies)( for)?|tools? for|various|misc(ellaneous)?|stuff|does (stuff|things)|general)\b/i;
const TRIGGER = /\b(when|whenever|if|use (this |it )?(for|to|on|with|in)|use (this|it)\b|before|after|asks?|requests?|mentions?|trigger)/i;
const PERSON = /^\s*(I|I'm|I'll|I can|We|We'll|You|You'll|You can)\b|\bI can help\b/;

/** Relative links and file mentions in markdown text, with their offsets. */
export function references(text: string): { target: string; index: number; kind: "link" | "path" }[] {
  const out: { target: string; index: number; kind: "link" | "path" }[] = [];
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/g)) out.push({ target: m[1], index: m.index!, kind: "link" });
  for (const m of text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(\s|$)/gm)) out.push({ target: m[1], index: m.index!, kind: "link" });
  for (const m of text.matchAll(/(?:^|[\s"'`(=])(?:\$\{?CLAUDE_SKILL_DIR\}?\/|\.\/)?((?:scripts|references|assets)[\\/][\w.\\/-]*\.[A-Za-z0-9]+)(?=$|[\s"'`),:;])/gm)) {
    out.push({ target: m[1], index: m.index! + m[0].indexOf(m[1]), kind: "path" });
  }
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.target) && Boolean(seen.add(r.target))).filter((r) => !/^[a-z][a-z0-9+.-]*:/i.test(r.target) && !r.target.startsWith("#") && !/[{}<>*?$]/.test(r.target));
}

function resolveRef(fromDir: string, target: string): string {
  let t = target.replace(/[#?].*$/, "");
  try { t = decodeURIComponent(t); } catch { /* keep as is */ }
  return resolve(fromDir, t.replace(/\\/g, "/"));
}

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + sep);

/** Markdown files in a skill other than SKILL.md, for text checks. */
const docs = (s: Skill) => listFiles(s.dir).filter((f) => /\.(md|mdx|markdown|txt)$/i.test(f.rel) && f.rel !== "SKILL.md");
const fileRel = (s: Skill, rel: string) => posix(join(dirname(s.file), rel)).replace(/^\.\//, "");

/** SKILL.md plus the skill's other text documents, each with the file path to report. */
function texts(s: Skill): { file: string; text: string; base: string }[] {
  const out = [{ file: s.file, text: s.raw.replace(/\r\n?/g, "\n"), base: s.dir }];
  for (const f of docs(s)) { const t = readText(f); if (t !== undefined) out.push({ file: fileRel(s, f.rel), text: t.replace(/\r\n?/g, "\n"), base: dirname(f.path) }); }
  return out;
}

export const rules: Rule[] = [
  make("frontmatter-missing", "error", "SKILL.md starts with a --- line and YAML frontmatter.", SPEC, (s) =>
    s.hasFrontmatter ? [] : [{
      line: 1,
      message: /^\s*\n*---/.test(s.raw) || s.raw.startsWith("\ufeff")
        ? "The opening --- is not on the first line, so hosts do not read the frontmatter."
        : "SKILL.md has no frontmatter, so hosts have no name or description to show the model.",
      fix: "Start the file with ---, then name: and description: lines, then ---.",
    }]),
  make("frontmatter-invalid", "error", "The frontmatter is valid YAML with key: value pairs.", SPEC, (s) =>
    s.hasFrontmatter && s.frontmatterError ? [{ line: 1, message: `The frontmatter cannot be read: ${s.frontmatterError}`, fix: "Fix the YAML. Quote values that contain a colon followed by a space." }] : []),
  make("name-missing", "error", "The frontmatter has a name.", SPEC, parsed((s, fm) =>
    fm.name === undefined || fm.name === null || fm.name === "" ? [{ line: 1, message: "There is no name. The spec, Codex and Cursor need one (Claude Code falls back to the folder name).", fix: `Add name: ${s.dirName}` }]
      : typeof fm.name !== "string" ? [{ line: fieldLine(s, "name"), message: "The name is not a string.", fix: "Write the name as plain text." }] : [])),
  make("name-format", "error", "The name is 1 to 64 lowercase letters, digits and single hyphens.", SPEC, parsed((s, fm) => {
    const n = str(fm.name);
    if (!n) return [];
    const why = n.length > 64 ? `is ${n.length} characters, over the limit of 64`
      : !/^[a-z0-9-]+$/.test(n) ? "has characters other than lowercase letters, digits and hyphens"
        : /^-|-$/.test(n) ? "starts or ends with a hyphen"
          : n.includes("--") ? "has two hyphens in a row" : undefined;
    return why ? [{ line: fieldLine(s, "name"), message: `The name ${why}.`, fix: "Use lowercase words joined by single hyphens, such as pdf-processing." }] : [];
  })),
  make("name-matches-folder", "error", "The name matches the skill's folder name.", SPEC, parsed((s, fm) => {
    const n = str(fm.name);
    return n && n !== s.dirName ? [{ line: fieldLine(s, "name"), message: `The name "${n}" does not match the folder "${s.dirName}". The spec and Cursor need them to match.`, fix: `Rename the folder to ${n}, or set name: ${s.dirName}` }] : [];
  })),
  make("description-missing", "error", "The frontmatter has a description.", SPEC, parsed((s, fm) =>
    typeof fm.description === "string" && fm.description.trim() ? []
      : [{ line: fieldLine(s, "description") ?? 1, message: fm.description === undefined ? "There is no description, so the model cannot tell when to use the skill." : "The description is empty or not text.", fix: "Add a description that says what the skill does and when to use it." }])),
  make("description-too-long", "error", "The description is at most 1,024 characters.", SPEC, parsed((s, fm) => {
    const d = str(fm.description);
    return d && d.length > 1024 ? [{ line: fieldLine(s, "description"), message: `The description is ${d.length} characters, over the limit of 1,024.`, fix: "Keep the trigger words and the main use case. Move detail into the body." }] : [];
  })),
  make("description-short", "warning", "The description is at least 40 characters.", BEST, parsed((s, fm) => {
    const d = str(fm.description)?.trim();
    return d && d.length < 40 ? [{ line: fieldLine(s, "description"), message: `The description is only ${d.length} characters. Models pick skills from this text alone.`, fix: "Say what the skill does, the key terms users say, and when to use it." }] : [];
  })),
  make("description-vague", "warning", "The description opens with what the skill does, not \"Helps with\".", BEST, parsed((s, fm) => {
    const d = str(fm.description);
    return d && VAGUE.test(d) ? [{ line: fieldLine(s, "description"), message: "The description opens with vague words such as \"Helps with\" or \"Handles\".", fix: "Name the concrete actions, for example \"Extracts text and tables from PDF files\"." }] : [];
  })),
  make("description-no-trigger", "warning", "The description says when to use the skill.", BEST, parsed((s, fm) => {
    const d = str(fm.description);
    return d && d.trim().length >= 1 && !TRIGGER.test(d) && !str(fm.when_to_use) ? [{ line: fieldLine(s, "description"), message: "The description says what the skill is, but not when to use it.", fix: "Add a sentence such as \"Use when the user mentions PDFs, forms or document extraction.\"" }] : [];
  })),
  make("description-person", "warning", "The description is written in the third person.", BEST, parsed((s, fm) => {
    const d = str(fm.description);
    return d && PERSON.test(d) ? [{ line: fieldLine(s, "description"), message: "The description speaks as \"I\" or \"you\". It is injected into the system prompt, where that reads badly.", fix: "Write \"Processes Excel files\" rather than \"I can help you process Excel files\"." }] : [];
  })),
  make("compatibility-too-long", "error", "The compatibility field is at most 500 characters.", SPEC, parsed((s, fm) => {
    if (fm.compatibility === undefined) return [];
    const c = str(fm.compatibility);
    return c === undefined ? [{ line: fieldLine(s, "compatibility"), message: "compatibility is not text.", fix: "Write it as one short sentence." }]
      : c.length > 500 ? [{ line: fieldLine(s, "compatibility"), message: `compatibility is ${c.length} characters, over the limit of 500.`, fix: "Keep it to the environment needs, such as \"Requires git and Python 3\"." }] : [];
  })),
  make("metadata-shape", "warning", "metadata maps text keys to text values.", SPEC, parsed((s, fm) => {
    const m = fm.metadata;
    if (m === undefined) return [];
    const ok = m !== null && typeof m === "object" && !Array.isArray(m) && Object.values(m).every((v) => typeof v === "string");
    return ok ? [] : [{ line: fieldLine(s, "metadata"), message: "metadata should map text keys to text values. Some hosts reject anything else.", fix: "Quote numbers and dates, for example version: \"1.0\"." }];
  })),
  make("unknown-field", "warning", "Frontmatter fields are ones the spec or a host documents.", SPEC, parsed((s, fm) =>
    Object.keys(fm).filter((k) => !KNOWN_FIELDS.has(k)).map((k) => ({
      line: fieldLine(s, k),
      message: `"${k}" is not a field the spec or any host documents. claude.ai and the Claude API reject unknown fields.`,
      fix: "Move it under metadata:, or remove it.",
    })))),
  make("body-empty", "warning", "SKILL.md has instructions after the frontmatter.", SPEC, parsed((s) =>
    s.body.trim() ? [] : [{ line: s.bodyLine, message: "There are no instructions after the frontmatter, so the skill does nothing when it loads.", fix: "Write the steps the agent should follow." }])),
  make("body-too-long", "warning", "The SKILL.md body is under 500 lines.", SPEC, (s) => {
    const n = s.body.split("\n").length;
    return n > 500 ? [{ line: s.bodyLine, message: `The body is ${n} lines. The spec, Claude and Codex advise under 500.`, fix: "Move reference material into references/ and link to it." }] : [];
  }),
  make("body-tokens", "warning", "The SKILL.md body is under about 5,000 tokens.", SPEC, (s) => {
    const n = estimateTokens(s.body);
    return n > 5000 ? [{ line: s.bodyLine, message: `The body is about ${n.toLocaleString("en-NZ")} tokens. The spec recommends under 5,000, since it all loads at once.`, fix: "Move detail into separate files the agent reads only when needed." }] : [];
  }),
  make("broken-link", "error", "Relative links and file paths in the skill point to files that exist.", SPEC, (s) =>
    texts(s).flatMap(({ file, text, base }) => {
      const seen = new Set<string>();
      return references(text).flatMap((r) => {
        // Paths such as scripts/x.py in a reference file usually mean the skill's own folder.
        const target = resolveRef(r.kind === "path" ? s.dir : base, r.target);
        if (isAbsolute(r.target) || seen.has(target) || existsSync(target)) return [];
        seen.add(target);
        return [{ file, line: lineOf(text, r.index), message: `${r.kind === "link" ? "The link" : "The path"} ${r.target} points to a file that does not exist.`, fix: "Fix the path, or add the missing file." }];
      });
    })),
  make("link-outside-skill", "warning", "Links stay inside the skill folder.", SPEC, (s) =>
    texts(s).flatMap(({ file, text, base }) => {
      return references(text).filter((r) => r.kind === "link" && !inside(s.dir, resolveRef(base, r.target))).map((r) => ({
        file, line: lineOf(text, r.index),
        message: `The link ${r.target} leaves the skill folder. Installed copies of the skill will not have it.`,
        fix: "Copy the file into the skill folder (references/ or assets/) and link to it there.",
      }));
    })),
  make("windows-path", "warning", "Paths use forward slashes.", BEST, (s) =>
    texts(s).flatMap(({ file, text }) => references(text).filter((r) => r.target.includes("\\")).map((r) => ({
      file, line: lineOf(text, r.index), message: `The path ${r.target} uses backslashes, which break on macOS and Linux.`, fix: "Use forward slashes, which work everywhere.",
    })))),
  make("nested-reference", "info", "Reference files are one level deep from SKILL.md.", SPEC, (s) => {
    const linked = new Set(references(s.body).map((r) => resolveRef(s.dir, r.target)).filter((p) => /\.mdx?$/i.test(p) && inside(s.dir, p) && existsSync(p)));
    return [...linked].flatMap((p) => {
      let text: string;
      try { text = statSync(p).size < 1_000_000 ? readFileSync(p, "utf8") : ""; } catch { return []; }
      const deeper = references(text).filter((r) => r.kind === "link" && /\.mdx?($|#)/i.test(r.target) && !linked.has(resolveRef(dirname(p), r.target)));
      return deeper.length ? [{ file: fileRel(s, posix(relative(s.dir, p))), line: lineOf(text, deeper[0].index), message: `This reference links on to ${deeper[0].target}. Agents may only skim files reached through a chain.`, fix: "Link every reference file straight from SKILL.md." }] : [];
    });
  }),
  make("unreferenced-file", "info", "Helper files in scripts/ and references/ are mentioned somewhere.", SPEC, (s) => {
    const t = texts(s);
    const all = t.map((x) => x.text).join("\n");
    const linked = new Set(t.flatMap((x) => references(x.text).map((r) => resolveRef(r.kind === "path" ? s.dir : x.base, r.target))));
    return listFiles(s.dir).filter((f) => /^(scripts|references)\//.test(f.rel)).filter((f) => {
      const tail = f.rel.split("/").pop()!;
      return !linked.has(resolve(f.path)) && !all.includes(f.rel) && !all.includes(tail);
    }).slice(0, 20).map((f) => ({ file: fileRel(s, f.rel), message: `${f.rel} is not mentioned in SKILL.md or its references, so the agent will not know to use it.`, fix: "Say in SKILL.md when to read or run it, or remove it." }));
  }),
  make("script-not-executable", "warning", "Scripts with a #! line are executable.", SPEC, (s) =>
    process.platform === "win32" ? [] : listFiles(s.dir).filter((f) => f.rel.startsWith("scripts/") && (f.mode & 0o111) === 0).filter((f) => readText(f, 200_000)?.startsWith("#!")).map((f) => ({
      file: fileRel(s, f.rel), line: 1, message: `${f.rel} starts with #! but is not executable, so running it directly fails.`, fix: `chmod +x ${f.rel}, then commit (git keeps the mode).`,
    }))),
  make("script-no-shebang", "info", "Shell scripts start with a #! line.", SPEC, (s) =>
    listFiles(s.dir).filter((f) => f.rel.startsWith("scripts/") && /\.(sh|bash|zsh)$/.test(f.rel)).filter((f) => { const t = readText(f, 200_000); return t !== undefined && !t.startsWith("#!"); }).map((f) => ({
      file: fileRel(s, f.rel), line: 1, message: `${f.rel} has no #! line, so it runs with whatever shell calls it.`, fix: "Start it with #!/usr/bin/env bash (or sh).",
    }))),
  make("secret", "error", "No API keys, tokens or private keys in skill files.", undefined, (s) =>
    listFiles(s.dir).flatMap((f) => {
      const t = readText(f);
      if (t === undefined) return [];
      return findSecrets(t).map((h) => ({ file: fileRel(s, f.rel), line: lineOf(t, h.index), message: `This looks like ${h.kind} (${h.preview}). Anyone who installs the skill gets it.`, fix: "Remove it, revoke it, and read keys from an environment variable instead." }));
    })),
  make("hidden-characters", "error", "No invisible, control or bidi characters.", CLAUDE, (s) =>
    listFiles(s.dir).flatMap((f) => {
      const t = readText(f);
      if (t === undefined) return [];
      const m = [...t.matchAll(HIDDEN)].filter((x) => !(x.index === 0 && x[0] === "\ufeff" && f.rel !== "SKILL.md"));
      return m.length ? [{ file: fileRel(s, f.rel), line: lineOf(t, m[0].index!), message: `The file has ${m.length} invisible or control character${m.length > 1 ? "s" : ""} (first: ${describeChar(m[0][0])}), which can hide instructions from people reviewing it.`, fix: "Remove zero-width, bidi override, tag and control characters." }] : [];
    })),
  make("suspicious-instructions", "error", "No text that turns the model against the user.", undefined, (s) =>
    texts(s).flatMap(({ file, text }) => text.split("\n").flatMap((l, i) => SUSPICIOUS.filter(([re]) => re.test(l)).map(([, why]) => ({
      file, line: i + 1, message: `The text ${why}. This is how prompt injection hides in skills.`, fix: "Describe the task plainly. Never ask the model to hide things, skip checks or send data elsewhere.",
    }))))),
  make("credential-access", "warning", "No reading of credential files such as ~/.ssh or ~/.aws.", undefined, (s) =>
    texts(s).flatMap(({ file, text }) => text.split("\n").flatMap((l, i) => CREDENTIAL_FILES.test(l) ? [{
      file, line: i + 1, message: "The skill mentions a credential file. A skill rarely needs to read one, and an injected one would.", fix: "Remove it, or explain why the skill needs it and ask the user first.",
    }] : []))),
  make("remote-code", "warning", "No downloading and running code in one step (curl | sh).", undefined, (s) =>
    listFiles(s.dir).flatMap((f) => {
      const t = readText(f);
      if (t === undefined) return [];
      return t.split("\n").flatMap((l, i) => REMOTE_CODE.test(l) ? [{ file: fileRel(s, f.rel), line: i + 1, message: "This downloads code and runs it straight away, so whoever controls that URL controls the agent's machine.", fix: "Pin a version, check a hash, or ship the script inside the skill." }] : []);
    })),
  make("dynamic-command", "warning", "Commands that Claude Code runs on load (!`cmd`) are safe.", CLAUDE, (s) => {
    const body = s.body;
    const hits: Hit[] = [];
    for (const m of body.matchAll(/!`([^`\n]+)`/g)) if (RISKY_COMMAND.test(m[1])) hits.push({ line: s.bodyLine + lineOf(body, m.index!) - 1, message: `Claude Code runs !\`${m[1].slice(0, 60)}\` before the model sees the skill, with no prompt.`, fix: "Keep load-time commands read-only and local, such as git status." });
    for (const m of body.matchAll(/^```!\s*\n([\s\S]*?)^```/gm)) if (RISKY_COMMAND.test(m[1])) hits.push({ line: s.bodyLine + lineOf(body, m.index!) - 1, message: "Claude Code runs this ```! block before the model sees the skill, and it uses network or destructive commands.", fix: "Keep load-time commands read-only and local." });
    return hits;
  }),
  make("allowed-tools-broad", "warning", "allowed-tools does not pre-approve every shell command.", CLAUDE, parsed((s, fm) => {
    const v = fm["allowed-tools"];
    const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+(?![^(]*\))/) : []).map(String);
    const broad = list.filter((t) => /^(\*|Bash|Bash\(\*(:\*)?\)|PowerShell|PowerShell\(\*\))$/.test(t.trim()));
    return broad.length ? [{ line: fieldLine(s, "allowed-tools"), message: `allowed-tools pre-approves ${broad.join(", ")}, so any shell command runs without asking while the skill is active.`, fix: "List only the commands the skill needs, such as Bash(git status *)." }] : [];
  })),
  {
    id: "duplicate-name",
    severity: "warning",
    summary: "No two skills share a name.",
    source: SPEC,
    check: (p) => {
      const by = new Map<string, Skill[]>();
      for (const s of p.skills) { const n = skillName(s); by.set(n, [...(by.get(n) ?? []), s]); }
      return [...by].filter(([, l]) => l.length > 1).flatMap(([n, l]) => l.map((s) => ({
        rule: "duplicate-name", severity: "warning" as const, skill: n, file: s.file, source: SPEC,
        message: `${l.length} skills are called ${n} (${l.map((x) => x.file).join(", ")}). Hosts show one, or both, and the model cannot tell them apart.`,
        fix: "Give each skill its own name.",
      })));
    },
  },
];

export function runRules(p: Project, only?: string[], extra: Rule[] = []): Finding[] {
  const all = [...rules, ...extra];
  const chosen = only?.length ? all.filter((r) => only.includes(r.id)) : all;
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return chosen.flatMap((r) => r.check(p)).sort((a, b) =>
    order[a.severity] - order[b.severity] || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}
