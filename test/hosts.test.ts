import { describe, expect, it } from "vitest";
import { discover } from "../src/discover.js";
import { hostRules, loadHostPack } from "../src/hosts.js";
import { runRules } from "../src/rules/index.js";
import { main } from "../src/main.js";
import { capture, GOOD_DESC, skill, tree } from "./helpers.js";

const pack = loadHostPack();
const hostFindings = (root: string, hosts?: string[]) =>
  runRules(discover(root), undefined, hostRules(pack, hosts)).filter((f) => f.host);
const ids = (root: string, hosts?: string[]) => hostFindings(root, hosts).map((f) => f.rule).sort();

describe("host rule pack", () => {
  it("loads, and every rule has an official source, a quote and a check date", () => {
    expect(pack.rules.length).toBeGreaterThanOrEqual(10);
    for (const r of pack.rules) {
      expect(r.source, r.id).toMatch(/^https:\/\/(code\.claude\.com|platform\.claude\.com|developers\.openai\.com|cursor\.com|geminicli\.com)\//);
      expect(r.quote.length, r.id).toBeGreaterThan(10);
      expect(String(r.checked), r.id).toMatch(/^2026-11-03/);
    }
    expect(new Set(pack.rules.map((r) => r.id)).size).toBe(pack.rules.length);
  });

  it("cuts Claude Code listings over 1,536 characters", () => {
    const root = tree({ ".claude/skills/long/SKILL.md": skill("long", `${GOOD_DESC} ${"x".repeat(900)}`, "Do it.\n", `when_to_use: ${"y".repeat(700)}\n`) });
    expect(ids(root)).toContain("claude-code-listing-length");
  });

  it("flags reserved folders and refused name characters for Claude Code", () => {
    const root = tree({
      ".claude/skills/synced/SKILL.md": skill("synced", GOOD_DESC),
      ".claude/skills/odd/SKILL.md": skill("\"odd\u200bname\"", GOOD_DESC),
    });
    expect(ids(root)).toEqual(expect.arrayContaining(["claude-code-reserved-folder", "claude-code-name-characters"]));
  });

  it("runs Claude API rules only when asked", () => {
    const root = tree({ "skills/claude-helper/SKILL.md": skill("claude-helper", `${GOOD_DESC} Wraps <b>tags</b>.`, "Do it.\n", "model: opus\n") });
    expect(ids(root).filter((i) => i.startsWith("claude-api"))).toEqual([]);
    expect(ids(root, ["claude-api"])).toEqual(["claude-api-allowed-fields", "claude-api-name-reserved", "claude-api-no-xml"]);
  });

  it("warns when Codex's 8,000-character listing budget is spent", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`.agents/skills/s${i}/SKILL.md`] = skill(`s${i}`, `${GOOD_DESC} ${"z".repeat(850)}`);
    const f = hostFindings(tree(files), ["codex"]);
    expect(f.map((x) => x.rule)).toEqual(["codex-listing-budget"]);
    expect(f[0].message).toMatch(/^\[codex\] 10 skills/);
  });

  it("checks Cursor names and the legacy globs field", () => {
    const root = tree({
      ".cursor/skills/a/SKILL.md": "---\ndescription: " + GOOD_DESC + "\nglobs: \"*.ts\"\n---\nDo it.\n",
    });
    expect(ids(root)).toEqual(["cursor-legacy-globs", "cursor-name-required"]);
  });

  it("finds Gemini skills hidden by an .agents/skills skill of the same name", () => {
    const root = tree({
      ".agents/skills/dup/SKILL.md": skill("dup", GOOD_DESC),
      ".gemini/skills/dup/SKILL.md": skill("dup", GOOD_DESC),
    });
    const f = hostFindings(root, ["gemini"]);
    expect(f.map((x) => [x.rule, x.file])).toEqual([["gemini-shadowed-skill", ".gemini/skills/dup/SKILL.md"]]);
  });

  it("does not apply a host's rules to skills only another host loads", () => {
    const root = tree({ ".gemini/skills/x/SKILL.md": "---\ndescription: " + GOOD_DESC + "\n---\nDo it.\n" });
    expect(ids(root, ["cursor"])).toEqual([]);
  });
});

describe("plugin rules", () => {
  it("flags broken manifests and bad Claude plugin names", () => {
    const root = tree({
      "a/.claude-plugin/plugin.json": JSON.stringify({ name: "my plugin" }),
      "b/.claude-plugin/plugin.json": JSON.stringify({ version: "1.0.0" }),
      "c/gemini-extension.json": "{ nope",
    });
    const f = runRules(discover(root));
    expect(f.map((x) => `${x.rule} ${x.file}`).sort()).toEqual([
      "plugin-invalid c/gemini-extension.json",
      "plugin-name a/.claude-plugin/plugin.json",
      "plugin-name b/.claude-plugin/plugin.json",
    ]);
  });
});

describe("cli host options", () => {
  it("lists host rules with quotes and rejects unknown hosts", async () => {
    let out = capture();
    expect(await main(["hosts"])).toBe(0);
    expect(out.join("\n")).toContain("8,000 characters");
    out = capture();
    expect(await main(["check", "test/fixtures/good", "--host", "nope"])).toBe(2);
    expect(out.join("\n")).toMatch(/Unknown host "nope"/);
  });

  it("records the pack version, and --no-hosts leaves it out", async () => {
    let out = capture();
    await main(["check", "test/fixtures/good", "--json"]);
    expect(JSON.parse(out.join("")).hostPack).toBe(pack.version);
    out = capture();
    await main(["check", "test/fixtures/good", "--json", "--no-hosts"]);
    expect(JSON.parse(out.join("")).hostPack).toBeUndefined();
  });
});
