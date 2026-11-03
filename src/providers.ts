/** A skill as a host lists it to the model: only its name and description. */
export interface Listing {
  name: string;
  description: string;
}

/** What a model chose when shown the skill listings and one prompt. */
export interface Choice {
  /** The skill it loaded, or null if it answered without one. */
  skill: string | null;
  /** Any text it wrote instead of, or as well as, the call. */
  text?: string;
}

export interface ChooseRequest {
  system?: string;
  prompt: string;
  skills: Listing[];
}

export interface Provider {
  /** For example "openai:gpt-4o-mini". */
  id: string;
  choose(req: ChooseRequest): Promise<Choice>;
  /** Plain text completion, used by fix mode to rewrite descriptions. */
  complete(system: string, prompt: string): Promise<string>;
}

export interface ProviderOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  temperature?: number;
  timeoutMs?: number;
}

/** The tool hosts give the model for loading a skill, reduced to its one argument. */
export const TOOL = "load_skill";

/**
 * The system prompt: the skill list in the shape hosts use, then the user's own system text.
 * Names and descriptions are passed as data inside the list, never as instructions.
 */
export function systemFor(skills: Listing[], extra?: string): string {
  const list = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`).join("\n");
  return [
    `You can load a skill with the ${TOOL} tool when one fits the user's request. Load at most one, and only if it clearly fits. If none fits, answer without a tool.`,
    "",
    "Available skills:",
    list,
    ...(extra ? ["", extra] : []),
  ].join("\n");
}

function toolSchema(skills: Listing[]) {
  return {
    type: "object",
    properties: { name: { type: "string", enum: skills.map((s) => s.name), description: "Name of the skill to load." } },
    required: ["name"],
  };
}

function pickName(raw: unknown, skills: Listing[]): string | null {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  const name = v && typeof v === "object" ? (v as Record<string, unknown>).name : undefined;
  if (typeof name !== "string") return null;
  // A name the model made up still counts as a pick, so it shows up as a wrong answer, not as no answer.
  return skills.some((s) => s.name === name) ? name : name.slice(0, 200);
}

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${url} did not answer with JSON.`); }
}

/** Any API that speaks the OpenAI chat completions format: OpenAI, OpenRouter, Ollama, LM Studio, vLLM. */
export function openAICompatible(id: string, baseUrl: string, model: string, apiKey: string | undefined, o: ProviderOptions = {}): Provider {
  const f = o.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  return {
    id,
    async choose({ system, prompt, skills }) {
      const body = {
        model,
        temperature: o.temperature ?? 0,
        messages: [{ role: "system", content: systemFor(skills, system) }, { role: "user", content: prompt }],
        tools: [{ type: "function", function: { name: TOOL, description: "Load one of the available skills.", parameters: toolSchema(skills) } }],
        tool_choice: "auto",
      };
      const data = await post(f, url, auth, body, o.timeoutMs ?? 60_000);
      const msg = data?.choices?.[0]?.message ?? {};
      const call = (msg.tool_calls ?? []).find((c: { function?: { name?: string } }) => c?.function?.name === TOOL)?.function;
      return { skill: call ? pickName(call.arguments, skills) : null, text: typeof msg.content === "string" ? msg.content : undefined };
    },
    async complete(system, prompt) {
      const body = { model, temperature: o.temperature ?? 0, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] };
      const data = await post(f, url, auth, body, o.timeoutMs ?? 60_000);
      return String(data?.choices?.[0]?.message?.content ?? "");
    },
  };
}

export function anthropic(model: string, apiKey: string, o: ProviderOptions = {}, baseUrl = "https://api.anthropic.com"): Provider {
  const f = o.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  return {
    id: `anthropic:${model}`,
    async choose({ system, prompt, skills }) {
      const body = {
        model,
        max_tokens: 1024,
        temperature: o.temperature ?? 0,
        system: systemFor(skills, system),
        messages: [{ role: "user", content: prompt }],
        tools: [{ name: TOOL, description: "Load one of the available skills.", input_schema: toolSchema(skills) }],
      };
      const data = await post(f, url, headers, body, o.timeoutMs ?? 60_000);
      const blocks: Array<Record<string, unknown>> = Array.isArray(data?.content) ? data.content : [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") || undefined;
      const use = blocks.find((b) => b.type === "tool_use" && b.name === TOOL);
      return { skill: use ? pickName(use.input, skills) : null, text };
    },
    async complete(system, prompt) {
      const body = { model, max_tokens: 1024, temperature: o.temperature ?? 0, system, messages: [{ role: "user", content: prompt }] };
      const data = await post(f, url, headers, body, o.timeoutMs ?? 60_000);
      return (Array.isArray(data?.content) ? data.content : []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    },
  };
}

const STOP = new Set("a an the and or of to in on for with is are be it this that what how do does my me i you your please can from at by as use when skill".split(" "));
export const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));

/**
 * A model that needs no key or network: it picks the skill whose name and description share the most
 * words with the prompt. It is for tests and dry runs, not for judging real skills.
 */
export function mock(): Provider {
  return {
    id: "mock",
    async choose({ prompt, skills }) {
      const p = words(prompt);
      let best: string | null = null;
      let bestScore = 0;
      for (const s of skills) {
        const w = words(`${s.name.replace(/[_.-]/g, " ")} ${s.description}`);
        let n = 0;
        for (const x of p) if (w.has(x)) n++;
        if (n > bestScore) { best = s.name; bestScore = n; }
      }
      return { skill: best };
    },
    /** Builds a description from the prompts after "Prompts that should use it:", so fix mode can be tested offline. */
    async complete(_system, prompt) {
      const want = prompt.split("Prompts that should use it:")[1]?.split("\n\n")[0] ?? "";
      const asks = want.split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
      const old = /Current description: (.+)/.exec(prompt)?.[1] ?? "Does its stated job.";
      return asks.length ? `${old.replace(/\.?$/, ".")} Use when the user asks things like: ${asks.join("; ")}.` : old;
    },
  };
}

/**
 * Builds a provider from "provider:model". Keys come only from environment variables:
 * OPENAI_API_KEY (and OPENAI_BASE_URL), OPENROUTER_API_KEY, ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL),
 * OLLAMA_HOST, and SKILLMEDIC_BASE_URL with SKILLMEDIC_API_KEY for any other compatible API.
 */
export function makeProvider(spec: string, o: ProviderOptions = {}): Provider {
  const env = o.env ?? process.env;
  if (spec === "mock") return mock();
  const i = spec.indexOf(":");
  if (i < 1 || i === spec.length - 1) throw new Error(`--model should look like provider:model, for example ollama:llama3.1, or be mock. Got "${spec}".`);
  const kind = spec.slice(0, i);
  const model = spec.slice(i + 1);
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`Set ${name} in the environment to use ${kind}. skillmedic never takes keys on the command line.`);
    return v;
  };
  const https = (name: string, v: string) => {
    if (!/^https?:\/\/[^\s]+$/i.test(v)) throw new Error(`${name} must be an http or https URL.`);
    return v;
  };
  switch (kind) {
    case "openai":
      return openAICompatible(spec, https("OPENAI_BASE_URL", env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"), model, need("OPENAI_API_KEY"), o);
    case "openrouter":
      return openAICompatible(spec, "https://openrouter.ai/api/v1", model, need("OPENROUTER_API_KEY"), o);
    case "ollama": {
      const host = (env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
      return openAICompatible(spec, https("OLLAMA_HOST", `${/^https?:/.test(host) ? host : `http://${host}`}/v1`), model, undefined, o);
    }
    case "compatible":
      return openAICompatible(spec, https("SKILLMEDIC_BASE_URL", need("SKILLMEDIC_BASE_URL")), model, env.SKILLMEDIC_API_KEY, o);
    case "anthropic":
      return anthropic(model, need("ANTHROPIC_API_KEY"), o, https("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"));
    default:
      throw new Error(`Unknown provider "${kind}". Use openai, openrouter, ollama, anthropic, compatible or mock.`);
  }
}
