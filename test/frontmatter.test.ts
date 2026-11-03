import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("reads fields, their lines and the body", () => {
    const p = parseFrontmatter("---\nname: a\ndescription: b\n---\n\nBody\n");
    expect(p.data).toEqual({ name: "a", description: "b" });
    expect(p.fieldLines).toEqual({ name: 2, description: 3 });
    expect(p.bodyLine).toBe(5);
    expect(p.body.trim()).toBe("Body");
  });
  it("handles CRLF line endings", () => {
    expect(parseFrontmatter("---\r\nname: a\r\n---\r\nx").data).toEqual({ name: "a" });
  });
  it("needs --- on the first line", () => {
    expect(parseFrontmatter("\n---\nname: a\n---\n").hasFrontmatter).toBe(false);
  });
  it("reports a missing closing line", () => {
    expect(parseFrontmatter("---\nname: a\n").error).toMatch(/closing/);
  });
  it("reports bad YAML, duplicate keys and non-maps", () => {
    expect(parseFrontmatter("---\na: b: c\n---\n").error).toBeTruthy();
    expect(parseFrontmatter("---\na: 1\na: 2\n---\n").error).toMatch(/unique|duplicate/i);
    expect(parseFrontmatter("---\n- a\n---\n").error).toMatch(/key: value/);
  });
  it("treats empty frontmatter as no fields", () => {
    expect(parseFrontmatter("---\n---\nx").data).toEqual({});
  });
  it("refuses alias bombs", () => {
    const bomb = "---\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n---\n";
    expect(parseFrontmatter(bomb).error).toBeTruthy();
  });
});
