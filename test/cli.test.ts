import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { capture } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("check", () => {
  it("passes a good folder with exit code 0", async () => {
    const out = capture();
    expect(await main(["check", "test/fixtures/good"])).toBe(0);
    expect(out.join("\n")).toMatch(/2 skills, 0 plugins.*\n[\s\S]*Score 100\/100/);
  });
  it("fails a bad folder with exit code 1 and lists findings", async () => {
    const out = capture();
    expect(await main(["check", "test/fixtures/bad"])).toBe(1);
    expect(out.join("\n")).toContain("name-matches-folder");
  });
  it("prints JSON", async () => {
    const out = capture();
    await main(["check", "--json", "test/fixtures/bad"]);
    const r = JSON.parse(out.join("\n"));
    expect(r.tool).toBe("skillmedic");
    expect(r.summary.skills).toBe(4);
    expect(r.findings.length).toBeGreaterThan(5);
  });
  it("respects --fail-on and --rule", async () => {
    capture();
    expect(await main(["check", "--fail-on", "never", "test/fixtures/bad"])).toBe(0);
    expect(await main(["check", "--rule", "description-person", "test/fixtures/bad"])).toBe(0);
    expect(await main(["check", "--rule", "description-person", "--fail-on", "warning", "test/fixtures/bad"])).toBe(1);
  });
  it("exits 2 on usage errors", async () => {
    const out = capture();
    expect(await main([])).toBe(2);
    expect(await main(["nope"])).toBe(2);
    expect(await main(["check", "--fail-on", "sometimes"])).toBe(2);
    expect(await main(["check", "--rule", "nope"])).toBe(2);
    expect(await main(["check", "--max-files", "0"])).toBe(2);
    expect(await main(["check", "--max-files", "1.5"])).toBe(2);
    expect(await main(["check", "--bogus"])).toBe(2);
    expect(await main(["check", "a", "b"])).toBe(2);
    expect(await main(["check", "test/fixtures/good/.claude/skills/pdf-tools/references"])).toBe(2);
    expect(out.join("\n")).toMatch(/Found no SKILL.md/);
  });
  it("prints help, version and rules", async () => {
    const out = capture();
    expect(await main(["--help"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
    expect(await main(["rules"])).toBe(0);
    expect(out.join("\n")).toMatch(/Usage[\s\S]*\d+\.\d+\.\d+[\s\S]*broken-link/);
  });
});
