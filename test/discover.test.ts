import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../src/discover.js";
import { GOOD_DESC, skill, tree } from "./helpers.js";

describe("discover", () => {
  it("finds skills and tells which hosts load them", () => {
    const root = tree({
      ".claude/skills/a/SKILL.md": skill("a", GOOD_DESC),
      ".agents/skills/b/SKILL.md": skill("b", GOOD_DESC),
      ".cursor/skills/c/SKILL.md": skill("c", GOOD_DESC),
      ".gemini/skills/d/SKILL.md": skill("d", GOOD_DESC),
      "skills/e/SKILL.md": skill("e", GOOD_DESC),
      "node_modules/x/skills/f/SKILL.md": skill("f", GOOD_DESC),
    });
    const p = discover(root);
    const hosts = Object.fromEntries(p.skills.map((s) => [s.dirName, s.hosts]));
    expect(hosts).toEqual({ a: ["claude"], b: ["codex", "cursor", "gemini"], c: ["cursor"], d: ["gemini"], e: [] });
  });
  it("finds plugin manifests and gives plugin skills the plugin's host", () => {
    const root = tree({
      "p1/.claude-plugin/plugin.json": '{"name":"p1"}',
      "p1/skills/s1/SKILL.md": skill("s1", GOOD_DESC),
      "p2/.cursor-plugin/plugin.json": '{"name":"p2"}',
      "p3/.codex-plugin/plugin.json": "{nope",
      "p4/gemini-extension.json": '{"name":"p4","version":"1.0.0"}',
      "p5/plugin.json": '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"p5"}',
      "p6/plugin.json": '{"name":"not-a-plugin"}',
    });
    const p = discover(root);
    expect(p.plugins.map((x) => [x.file, x.format, Boolean(x.error)])).toEqual([
      ["p1/.claude-plugin/plugin.json", "claude", false],
      ["p2/.cursor-plugin/plugin.json", "cursor", false],
      ["p3/.codex-plugin/plugin.json", "codex", true],
      ["p4/gemini-extension.json", "gemini", false],
      ["p5/plugin.json", "agent", false],
    ]);
    expect(p.skills[0].hosts).toEqual(["claude"]);
    expect(p.skills[0].plugin).toBe("p1/.claude-plugin/plugin.json");
  });
  it("accepts a SKILL.md path and a manifest path", () => {
    const root = tree({ "a/SKILL.md": skill("a", GOOD_DESC), "p/.claude-plugin/plugin.json": '{"name":"p"}' });
    expect(discover(join(root, "a/SKILL.md")).skills).toHaveLength(1);
    expect(discover(join(root, "p/.claude-plugin/plugin.json")).plugins).toHaveLength(1);
    expect(() => discover(join(root, "p/.claude-plugin/../.claude-plugin/plugin.json"))).not.toThrow();
  });
  it("rejects other files", () => {
    const root = tree({ "x.txt": "x" });
    expect(() => discover(join(root, "x.txt"))).toThrow(/not a SKILL.md/);
  });
  it.skipIf(process.platform === "win32")("does not follow symbolic links", () => {
    const outside = tree({ "secret/SKILL.md": skill("secret", GOOD_DESC) });
    const root = tree({ "a/SKILL.md": skill("a", GOOD_DESC) });
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(root, "a"), join(root, "a", "loop"));
    expect(discover(root).skills.map((s) => s.dirName)).toEqual(["a"]);
  });
  it("stops at the file limit and says so", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`s${i}/SKILL.md`] = skill(`s${i}`, GOOD_DESC);
    const p = discover(tree(files), { maxFiles: 10 });
    expect(p.truncated).toBe(true);
    expect(p.skills.length).toBeLessThan(30);
  });
  it("reports a SKILL.md that is too big instead of reading it", () => {
    const root = tree({ "a/SKILL.md": skill("a", GOOD_DESC, "x".repeat(5000)) });
    expect(discover(root, { maxBytes: 1000 }).skills[0].frontmatterError).toMatch(/byte limit/);
  });
});
