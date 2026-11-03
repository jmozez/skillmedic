import type { Report } from "./report.js";
import type { Rule, Severity } from "./types.js";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { error: "error", warning: "warning", info: "note" };
const REPO = "https://github.com/jmozez/skillmedic";

/** SARIF 2.1.0, as read by GitHub code scanning and most editors. Pass the rules that ran for their summaries. */
export function formatSarif(r: Report, known: Rule[] = []): string {
  const byId = new Map(known.map((x) => [x.id, x]));
  const ids = [...new Set(r.findings.map((f) => f.rule))];
  const descriptors = ids.map((id) => {
    const rule = byId.get(id);
    const f = r.findings.find((x) => x.rule === id)!;
    return {
      id,
      name: id.replace(/(^|[-_.:])(\w)/g, (_, __, c: string) => c.toUpperCase()),
      shortDescription: { text: rule?.summary ?? f.message },
      ...(f.fix ? { help: { text: f.fix } } : {}),
      helpUri: f.source ?? rule?.source ?? `${REPO}#checks`,
      defaultConfiguration: { level: LEVEL[rule?.severity ?? f.severity] },
      properties: { tags: f.host ? ["agent-skills", "host", f.host] : ["agent-skills"] },
    };
  });
  const prefix = r.root === "." ? "" : r.root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") + "/";
  const results = r.findings.map((f) => ({
    ruleId: f.rule,
    ruleIndex: ids.indexOf(f.rule),
    level: LEVEL[f.severity],
    message: { text: f.fix ? `${f.message} Fix: ${f.fix}` : f.message },
    locations: [{
      physicalLocation: { artifactLocation: { uri: prefix + (f.file ?? "") || "." }, region: { startLine: f.line ?? 1 } },
      ...(f.skill ? { logicalLocations: [{ name: f.skill, kind: "module" }] } : {}),
    }],
    partialFingerprints: { skillmedic: [f.rule, f.file ?? "", f.skill ?? "", f.host ?? ""].join("/") },
  }));
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "skillmedic", version: r.version, informationUri: REPO, rules: descriptors } },
      results,
      properties: { score: r.summary.score, hostPack: r.hostPack },
    }],
  }, null, 2);
}
