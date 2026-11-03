import { isMap, isScalar, parseDocument } from "yaml";

export interface Parsed {
  hasFrontmatter: boolean;
  data?: Record<string, unknown>;
  error?: string;
  fieldLines: Record<string, number>;
  body: string;
  bodyLine: number;
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * Reads YAML frontmatter the way the hosts do: the first line must be exactly ---,
 * and the block ends at the next --- line. The YAML parser limits aliases and has no
 * tags that run code, so a hostile file cannot blow up memory or execute anything.
 */
export function parseFrontmatter(raw: string): Parsed {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { hasFrontmatter: false, fieldLines: {}, body: text, bodyLine: 1 };
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { hasFrontmatter: true, error: "The frontmatter has no closing --- line.", fieldLines: {}, body: "", bodyLine: lines.length + 1 };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  const bodyLine = end + 2;
  const doc = parseDocument(yamlText, { uniqueKeys: true, prettyErrors: false, maxAliasCount: 50 } as never);
  if (doc.errors.length) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    return { hasFrontmatter: true, error: `${e.message.split("\n")[0]}${line ? ` (frontmatter line ${line})` : ""}`, fieldLines: {}, body, bodyLine };
  }
  let data: unknown;
  try { data = doc.toJS({ maxAliasCount: 50 }); }
  catch (e) { return { hasFrontmatter: true, error: (e as Error).message, fieldLines: {}, body, bodyLine }; }
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) return { hasFrontmatter: true, error: "The frontmatter is not a list of key: value pairs.", fieldLines: {}, body, bodyLine };
  const fieldLines: Record<string, number> = {};
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      if (isScalar(item.key) && item.key.range) fieldLines[String(item.key.value)] = lineAt(yamlText, item.key.range[0]) + 1;
    }
  }
  return { hasFrontmatter: true, data: data as Record<string, unknown>, fieldLines, body, bodyLine };
}
