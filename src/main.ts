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

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const HELP = `skillmedic ${VERSION}: check Agent Skills and plugins.

Usage
  skillmedic check [path]      check every SKILL.md and plugin manifest under path (default .)
  skillmedic rules             list every check
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
