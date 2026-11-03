export type Severity = "error" | "warning" | "info";

/** Plugin and extension manifest formats skillmedic knows. */
export type PluginFormat = "claude" | "codex" | "cursor" | "agent" | "gemini";

export interface Skill {
  /** Absolute path of the skill folder. */
  dir: string;
  /** Path of SKILL.md relative to the checked root, with forward slashes. */
  file: string;
  /** Name of the folder that holds SKILL.md. */
  dirName: string;
  /** Full text of SKILL.md. */
  raw: string;
  /** False when the file does not open with a --- line. */
  hasFrontmatter: boolean;
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
  /** Line number of each top-level frontmatter key. */
  fieldLines: Record<string, number>;
  /** Text after the closing ---, and the line it starts on. */
  body: string;
  bodyLine: number;
  /** Hosts that load skills from this location. Empty means any host (a skill installed by copying). */
  hosts: string[];
  /** The plugin this skill ships in, if any (its manifest path). */
  plugin?: string;
}

export interface Plugin {
  /** Absolute path of the plugin root. */
  dir: string;
  /** Manifest path relative to the checked root, with forward slashes. */
  file: string;
  format: PluginFormat;
  manifest?: Record<string, unknown>;
  error?: string;
}

export interface Project {
  root: string;
  skills: Skill[];
  plugins: Plugin[];
  /** True when the file limit stopped the search early. */
  truncated?: boolean;
}

export interface Finding {
  rule: string;
  severity: Severity;
  /** Skill or plugin name (or folder name when it has none). */
  skill?: string;
  /** File relative to the checked root, with forward slashes. */
  file?: string;
  line?: number;
  message: string;
  fix?: string;
  /** For host rules: which host, and the page that documents the behaviour. */
  host?: string;
  source?: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  summary: string;
  /** The page the rule is based on. */
  source?: string;
  check(project: Project): Finding[];
}
