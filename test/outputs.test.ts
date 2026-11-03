import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discover } from "../src/discover.js";
import { rules, runRules } from "../src/rules/index.js";
import { buildReport } from "../src/report.js";
import { badgeJson, formatHtml } from "../src/html.js";
import { formatSarif } from "../src/sarif.js";
import { main } from "../src/main.js";
import type { Report } from "../src/report.js";

const report = (dir: string) => { const p = discover(dir); return buildReport(p, runRules(p), "0.0.0"); };

describe("html", () => {
  it("escapes text and drops non-https links", () => {
    const r: Report = { ...report("test/fixtures/good"), findings: [{ rule: "x", severity: "error", skill: "<script>alert(1)</script>", message: "a\u001b[31m\"b\"", source: "javascript:alert(1)" }] };
    const html = formatHtml(r);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("\u001b");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("default-src 'none'");
  });
  it("shows the score and every finding", () => {
    const r = report("test/fixtures/bad");
    const html = formatHtml(r);
    expect(html).toContain(`${r.summary.score}/100`);
    for (const f of r.findings) expect(html).toContain(f.rule);
  });
});

describe("badge", () => {
  it("is a shields.io endpoint", () => {
    const b = JSON.parse(badgeJson(report("test/fixtures/good")));
    expect(b).toMatchObject({ schemaVersion: 1, label: "skillmedic", color: "brightgreen" });
    expect(b.message).toMatch(/^\d+\/100$/);
  });
});

describe("sarif", () => {
  it("is SARIF 2.1.0 with a rule for every result and real file paths", () => {
    const r = report("test/fixtures/bad");
    const s = JSON.parse(formatSarif(r, rules));
    expect(s.version).toBe("2.1.0");
    const run = s.runs[0];
    expect(run.results.length).toBe(r.findings.length);
    for (const res of run.results) {
      expect(run.tool.driver.rules[res.ruleIndex].id).toBe(res.ruleId);
      expect(res.locations[0].physicalLocation.artifactLocation.uri).not.toContain("\\");
      expect(res.locations[0].physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
    }
    expect(run.results.some((x: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) => x.locations[0].physicalLocation.artifactLocation.uri.startsWith("test/fixtures/bad/"))).toBe(true);
  });
});

describe("cli outputs", () => {
  it("writes all three files", async () => {
    const d = mkdtempSync(join(tmpdir(), "sm-out-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["check", "test/fixtures/good", "--html", join(d, "r.html"), "--sarif", join(d, "r.sarif"), "--badge", join(d, "b.json")]);
    log.mockRestore();
    expect(code).toBe(0);
    expect(readFileSync(join(d, "r.html"), "utf8")).toContain("<!doctype html>");
    expect(JSON.parse(readFileSync(join(d, "r.sarif"), "utf8")).version).toBe("2.1.0");
    expect(JSON.parse(readFileSync(join(d, "b.json"), "utf8")).label).toBe("skillmedic");
  });
  it("exits 2 when a file cannot be written", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["check", "test/fixtures/good", "--html", join(tmpdir(), "no-such-dir-sm", "x", "r.html")]);
    err.mockRestore(); log.mockRestore();
    expect(code).toBe(2);
  });
});
