import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { discover } from "./discover.js";
import { rules, runRules } from "./rules/index.js";
import { buildReport, formatText } from "./report.js";
import { hostRules, loadHostPack } from "./hosts.js";
import type { Severity } from "./types.js";
import { printable } from "./sanitize.js";
import { badgeJson, formatHtml } from "./html.js";
import { formatSarif } from "./sarif.js";
import { writeFileSync } from "node:fs";
import { makeProvider } from "./providers.js";
import { formatFix, runFix } from "./fix.js";
import { formatEval, listings, loadSuite, runEval, unknownExpected } from "./eval.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const HELP = `skillmedic ${VERSION}: check Agent Skills and plugins.

Usage
  skillmedic check [path]      check every SKILL.md and plugin manifest under path (default .)
  skillmedic rules             list every check
  skillmedic eval <cases> [path]
                               check that a model picks the right skill for each prompt in a cases file
  skillmedic fix <cases> [path]
                               rewrite weak descriptions, keeping only those that raise eval accuracy
  skillmedic hosts             list the host rules, with the page and quote each is based on

Options
  --json                 print the report as JSON
  --html <file>          also write the report as a single HTML page
  --sarif <file>         also write SARIF 2.1.0 for GitHub code scanning
  --badge <file>         also write a shields.io endpoint badge with the score
  --fail-on <level>      exit with code 1 at this level or above: error (default), warning, info, never
  --rule <id>            run only this check (repeatable)
  --host <id>            run only this host's rules, including opt-in ones (repeatable):
                         claude-code, claude-api, codex, cursor, gemini
  --no-hosts             skip host rules
  --max-files <n>        stop searching after this many files, 1 to 1,000,000 (default 20,000)

Eval options
  --model <spec>         openai:<model>, anthropic:<model>, openrouter:<model>, ollama:<model>,
                         compatible:<model> (uses SKILLMEDIC_BASE_URL and SKILLMEDIC_API_KEY) or mock.
                         Keys come only from environment variables.
  --repeat <n>           run each case this many times to measure flakiness, 1 to 50 (default 3)
  --concurrency <n>      model calls at once, 1 to 16 (default 4)
  --timeout <seconds>    time limit for each model call, 1 to 600 (default 60)
  --min-accuracy <pct>   exit with code 1 below this accuracy (default 0, never fail)

Fix options (and the eval options above)
  --rewrite-model <spec> model that writes the new descriptions (default: the --model)
  --max-skills <n>       rewrite at most this many skills, 1 to 50 (default 10)
  --write                change the description lines in SKILL.md. Without it, fix only prints suggestions.

  -h, --help             show this help
  -v, --version          show the version

Exit codes: 0 no findings at the --fail-on level, 1 findings at that level, 2 usage or runtime error.
`;

const ORDER: Severity[] = ["info", "warning", "error"];

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        "fail-on": { type: "string", default: "error" },
        rule: { type: "string", multiple: true },
        "max-files": { type: "string", default: "20000" },
        host: { type: "string", multiple: true },
        html: { type: "string" },
        sarif: { type: "string" },
        badge: { type: "string" },
        model: { type: "string" },
        repeat: { type: "string", default: "3" },
        concurrency: { type: "string", default: "4" },
        timeout: { type: "string", default: "60" },
        "min-accuracy": { type: "string", default: "0" },
        "rewrite-model": { type: "string" },
        "max-skills": { type: "string", default: "10" },
        write: { type: "boolean", default: false },
        "no-hosts": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) { console.error(`${(e as Error).message} Run skillmedic --help.`); return 2; }
  const { values, positionals } = parsed;

  if (values.version) { console.log(VERSION); return 0; }
  const cmd = positionals[0];
  if (values.help || !cmd) { console.log(HELP); return values.help ? 0 : 2; }

  const pack = loadHostPack();
  if (cmd === "hosts") {
    for (const r of pack.rules) {
      console.log(`${r.id}  [${r.host}${r.default === false ? ", opt-in" : ""}] ${r.severity}`);
      console.log(`  ${r.summary}`);
      console.log(`  "${r.quote}"`);
      console.log(`  ${r.source} (checked ${r.checked})\n`);
    }
    return 0;
  }
  if (cmd === "rules") {
    for (const r of [...rules, ...hostRules(pack, Object.keys(pack.hosts))]) console.log(`${r.id.padEnd(30)} ${r.severity.padEnd(8)} ${r.summary}`);
    return 0;
  }
  if (cmd === "eval" || cmd === "fix") return evalCommand(cmd, values, positionals);
  if (cmd !== "check") { console.error(`Unknown command "${cmd}". Run skillmedic --help.`); return 2; }
  if (positionals.length > 2) { console.error(`Unexpected argument "${positionals[2]}". Give one path.`); return 2; }

  const failOn = values["fail-on"]!;
  if (![...ORDER, "never"].includes(failOn)) { console.error("--fail-on must be error, warning, info or never."); return 2; }
  const maxFiles = Number(values["max-files"]);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1_000_000) { console.error("--max-files must be a whole number from 1 to 1,000,000."); return 2; }
  for (const h of values.host ?? []) {
    if (!pack.hosts[h]) { console.error(`Unknown host "${h}". Use one of: ${Object.keys(pack.hosts).join(", ")}.`); return 2; }
  }
  const extra = values["no-hosts"] ? [] : hostRules(pack, values.host);
  const known = new Set([...rules, ...hostRules(pack, Object.keys(pack.hosts))].map((r) => r.id));
  for (const id of values.rule ?? []) {
    if (!known.has(id)) { console.error(`Unknown rule "${id}". Run skillmedic rules to see them.`); return 2; }
  }

  let project;
  try { project = discover(positionals[1] ?? ".", { maxFiles }); } catch (e) { console.error(`skillmedic: ${printable((e as Error).message)}`); return 2; }
  if (!project.skills.length && !project.plugins.length) {
    console.error(`Found no SKILL.md or plugin manifest under ${positionals[1] ?? "."}.`);
    return 2;
  }
  const report = buildReport(project, runRules(project, values.rule, extra), VERSION);
  if (extra.length) report.hostPack = pack.version;
  try {
    if (values.html) writeFileSync(values.html, formatHtml(report));
    if (values.sarif) writeFileSync(values.sarif, formatSarif(report, [...rules, ...extra]));
    if (values.badge) writeFileSync(values.badge, badgeJson(report));
  } catch (e) { console.error(`skillmedic: ${printable((e as Error).message)}`); return 2; }
  console.log(values.json ? JSON.stringify(report, null, 2) : formatText(report, process.stdout.isTTY));

  if (failOn === "never") return 0;
  const min = ORDER.indexOf(failOn as Severity);
  return report.findings.some((f) => ORDER.indexOf(f.severity) >= min) ? 1 : 0;
}

const int = (v: string | undefined, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined; };

async function evalCommand(cmd: "eval" | "fix", values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const casesFile = positionals[1];
  if (!casesFile) { console.error(`${cmd} needs a cases file: skillmedic ${cmd} cases.yaml [path].`); return 2; }
  if (cmd === "eval" && values.write) { console.error("--write is for fix, not eval."); return 2; }
  if (positionals.length > 3) { console.error(`Unexpected argument "${positionals[3]}".`); return 2; }
  if (typeof values.model !== "string") { console.error(`${cmd} needs --model <provider:model>, or --model mock for a dry run.`); return 2; }
  const repeat = int(values.repeat as string, 1, 50);
  const concurrency = int(values.concurrency as string, 1, 16);
  const timeout = int(values.timeout as string, 1, 600);
  const min = Number(values["min-accuracy"]);
  if (repeat === undefined) { console.error("--repeat must be a whole number from 1 to 50."); return 2; }
  if (concurrency === undefined) { console.error("--concurrency must be a whole number from 1 to 16."); return 2; }
  if (timeout === undefined) { console.error("--timeout must be a whole number of seconds from 1 to 600."); return 2; }
  if (!(min >= 0 && min <= 100)) { console.error("--min-accuracy must be a percentage from 0 to 100."); return 2; }
  const maxSkills = int(values["max-skills"] as string, 1, 50);
  if (maxSkills === undefined) { console.error("--max-skills must be a whole number from 1 to 50."); return 2; }
  let provider, rewriter, suite, project;
  try {
    provider = makeProvider(values.model, { timeoutMs: timeout * 1000 });
    rewriter = typeof values["rewrite-model"] === "string" ? makeProvider(values["rewrite-model"], { timeoutMs: timeout * 1000, temperature: 0.3 }) : provider;
    suite = loadSuite(casesFile);
    project = discover(positionals[2] ?? ".");
  } catch (e) { console.error(`skillmedic: ${printable((e as Error).message)}`); return 2; }
  const skills = listings(project);
  if (!skills.length) { console.error(`Found no SKILL.md under ${printable(positionals[2] ?? ".")}.`); return 2; }
  const unknown = unknownExpected(suite, skills);
  if (unknown.length) { console.error(`The cases file expects skills that were not found: ${printable(unknown.join(", "))}.`); return 2; }
  if (cmd === "fix") {
    const quiet = values.json || !process.stderr.isTTY;
    let r;
    try {
      r = await runFix(provider, rewriter, project, suite, { repeat, concurrency, maxSkills, write: Boolean(values.write), onStep: quiet ? undefined : (m) => process.stderr.write(`  ${printable(m)}...\n`) });
    } catch (e) { console.error(`skillmedic: ${printable((e as Error).message)}`); return 2; }
    console.log(values.json ? JSON.stringify(r, null, 2) : formatFix(r));
    if (r.baseline.summary.errors === r.baseline.summary.runs) { console.error("Every model call failed. Check the model name, the key and the network."); return 2; }
    return r.final.summary.accuracy * 100 < min ? 1 : 0;
  }
  const result = await runEval(provider, skills, suite, { repeat, concurrency });
  console.log(values.json ? JSON.stringify(result, null, 2) : formatEval(result));
  if (result.summary.errors === result.summary.runs) { console.error("Every model call failed. Check the model name, the key and the network."); return 2; }
  return result.summary.accuracy * 100 < min ? 1 : 0;
}
