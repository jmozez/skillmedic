import { describe, expect, it, vi } from "vitest";
import { discover } from "../src/discover.js";
import { listings, loadSuite, parseSuite, runEval, unknownExpected, formatEval, MAX_CASES } from "../src/eval.js";
import { anthropic, makeProvider, mock, openAICompatible, systemFor, type Provider } from "../src/providers.js";
import { main } from "../src/main.js";

const skills = listings(discover("test/fixtures/eval"));

describe("suite", () => {
  it("reads the cases file", () => {
    const s = loadSuite("test/fixtures/eval/cases.yaml");
    expect(s.cases).toHaveLength(4);
    expect(s.cases[3].expect).toEqual([]);
  });
  it("rejects bad files", () => {
    expect(() => parseSuite("cases: []")).toThrow(/no cases/);
    expect(() => parseSuite("- expect: x")).toThrow(/needs a prompt/);
    expect(() => parseSuite("- prompt: hi")).toThrow(/needs expect/);
    expect(() => parseSuite("a: [")).toThrow(/not valid YAML/);
    expect(() => parseSuite(Array.from({ length: MAX_CASES + 1 }, () => "- {prompt: a, expect: none}").join("\n"))).toThrow(/limit/);
  });
  it("finds names that are not skills", () => {
    expect(unknownExpected(parseSuite("- {prompt: a, expect: [pdf-forms, nope]}"), skills)).toEqual(["nope"]);
  });
});

describe("eval", () => {
  it("measures accuracy and mix-ups with the mock", async () => {
    const r = await runEval(mock(), skills, loadSuite("test/fixtures/eval/cases.yaml"), { repeat: 2 });
    expect(r.summary.runs).toBe(8);
    // The vague commit-message description loses its prompt, which is what eval is for.
    expect(r.cases[2].correct).toBe(0);
    expect(r.summary.accuracy).toBeCloseTo(0.75);
    expect(r.summary.consistency).toBe(1);
    expect(formatEval(r)).toContain("FAIL");
  });
  it("counts flaky cases and failed calls", async () => {
    let n = 0;
    const p: Provider = { id: "flip", complete: async () => "", choose: async () => { n++; if (n === 3) throw new Error("boom"); return { skill: n % 2 ? "pdf-forms" : "csv-report" }; } };
    const r = await runEval(p, skills, parseSuite("- {prompt: pdf, expect: pdf-forms}"), { repeat: 4, concurrency: 1 });
    expect(r.cases[0].consistent).toBe(false);
    expect(r.summary.errors).toBe(1);
    expect(r.summary.confusions[0]).toMatchObject({ expected: "pdf-forms", picked: "csv-report" });
  });
});

const fakeFetch = (reply: unknown, seen: { url?: string; init?: RequestInit }) =>
  (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(reply), { status: 200 }); }) as unknown as typeof fetch;

describe("providers", () => {
  it("lists skills as data in the system prompt", () => {
    expect(systemFor([{ name: "a", description: "x\ny" }])).toContain("- a: x y");
  });
  it("reads an OpenAI-compatible tool call", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const p = openAICompatible("t", "https://example.test/v1/", "m", "k", { fetch: fakeFetch({ choices: [{ message: { tool_calls: [{ function: { name: "load_skill", arguments: "{\"name\":\"csv-report\"}" } }] } }] }, seen) });
    expect((await p.choose({ prompt: "x", skills })).skill).toBe("csv-report");
    expect(seen.url).toBe("https://example.test/v1/chat/completions");
    expect((seen.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(String(seen.init!.body));
    expect(body.tools[0].function.parameters.properties.name.enum).toContain("pdf-forms");
  });
  it("reads an Anthropic tool use and a plain answer", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const p = anthropic("m", "k", { fetch: fakeFetch({ content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "load_skill", input: { name: "pdf-forms" } }] }, seen) });
    expect(await p.choose({ prompt: "x", skills })).toEqual({ skill: "pdf-forms", text: "hi" });
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    const q = anthropic("m", "k", { fetch: fakeFetch({ content: [{ type: "text", text: "no" }] }, {}) });
    expect((await q.choose({ prompt: "x", skills })).skill).toBeNull();
  });
  it("reports HTTP errors without the key", async () => {
    const f = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const p = openAICompatible("t", "https://example.test/v1", "m", "secret-value", { fetch: f });
    await expect(p.choose({ prompt: "x", skills })).rejects.toThrow(/401/);
    await expect(p.choose({ prompt: "x", skills })).rejects.not.toThrow(/secret-value/);
  });
  it("takes keys and URLs only from the environment", () => {
    expect(() => makeProvider("openai:gpt", { env: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() => makeProvider("compatible:m", { env: {} })).toThrow(/SKILLMEDIC_BASE_URL/);
    expect(() => makeProvider("compatible:m", { env: { SKILLMEDIC_BASE_URL: "file:///etc/passwd" } })).toThrow(/http/);
    expect(makeProvider("compatible:m", { env: { SKILLMEDIC_BASE_URL: "http://localhost:1234/v1" } }).id).toBe("compatible:m");
    expect(makeProvider("ollama:llama3.1", { env: { OLLAMA_HOST: "127.0.0.1:11434" } }).id).toBe("ollama:llama3.1");
    expect(makeProvider("anthropic:x", { env: { ANTHROPIC_API_KEY: "k" } }).id).toBe("anthropic:x");
    expect(() => makeProvider("nope:x", { env: {} })).toThrow(/Unknown provider/);
    expect(() => makeProvider("gpt", { env: {} })).toThrow(/provider:model/);
  });
});

describe("eval command", () => {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((s) => { out.push(String(s)); });
    const err = vi.spyOn(console, "error").mockImplementation((s) => { out.push(String(s)); });
    const code = await main(args);
    log.mockRestore(); err.mockRestore();
    return { code, out: out.join("\n") };
  };
  it("runs with the mock and honours --min-accuracy", async () => {
    expect((await run("eval", "test/fixtures/eval/cases.yaml", "test/fixtures/eval", "--model", "mock")).code).toBe(0);
    const strict = await run("eval", "test/fixtures/eval/cases.yaml", "test/fixtures/eval", "--model", "mock", "--min-accuracy", "90", "--json");
    expect(strict.code).toBe(1);
    expect(JSON.parse(strict.out).summary.accuracy).toBeCloseTo(0.75);
  });
  it("validates its options", async () => {
    expect((await run("eval")).code).toBe(2);
    expect((await run("eval", "test/fixtures/eval/cases.yaml")).code).toBe(2);
    for (const bad of [["--repeat", "0"], ["--concurrency", "99"], ["--timeout", "x"], ["--min-accuracy", "101"]]) {
      expect((await run("eval", "test/fixtures/eval/cases.yaml", "test/fixtures/eval", "--model", "mock", ...bad)).code).toBe(2);
    }
    expect((await run("eval", "test/fixtures/eval/cases.yaml", "test/fixtures/good", "--model", "mock")).out).toMatch(/not found/);
  });
});
