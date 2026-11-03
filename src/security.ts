/** Patterns for credentials that should never ship in a skill. Matches are redacted before they are shown. */
export const SECRETS: [RegExp, string][] = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{32,}/g, "an Anthropic API key"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, "an OpenAI-style API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "a Google API key"],
  [/\b[sr]k_live_[0-9A-Za-z]{20,}\b/g, "a Stripe live key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "an npm token"],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, "a private key"],
  [/\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi, "a hard-coded credential"],
];

const PLACEHOLDER = /your|xxxx|example|changeme|placeholder|dummy|redacted|<|\$\{|\$[A-Z_]|\{\{|\*\*\*/i;

/** Shannon entropy in bits per character, to tell real keys from words. */
function entropy(s: string): number {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of m.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export interface SecretHit { index: number; kind: string; preview: string }

export function findSecrets(text: string): SecretHit[] {
  const out: SecretHit[] = [];
  const seen = new Set<number>();
  for (const [re, kind] of SECRETS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0];
      if (seen.has(m.index!)) continue;
      if (m[1] !== undefined && (PLACEHOLDER.test(value) || entropy(value) < 3.5)) continue;
      if (m[1] === undefined && /EXAMPLE|XXXX|0{8}/.test(value)) continue;
      seen.add(m.index!);
      out.push({ index: m.index!, kind, preview: value.slice(0, 4) + "..." });
    }
  }
  return out;
}

/** Text that tries to steer the model against the user. Each entry is a pattern and what it does. */
export const SUSPICIOUS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|other|system)\b.{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i, "tells the model to ignore its instructions"],
  [/<\/?\s*(important|system|instructions?|secret|hidden|admin)\s*>/i, "hides orders in pseudo tags such as <IMPORTANT>"],
  [/\b(do not|don't|never)\b.{0,20}\b(tell|inform|mention|show|reveal|notify)\b.{0,20}\b(the )?user\b/i, "asks the model to keep something from the user"],
  [/\bwithout (asking|telling|confirming with|notifying|alerting) the user\b/i, "asks the model to act behind the user's back"],
  [/\bbefore (using|calling|running|loading) (any|every|all|other|another)\b.{0,15}\b(tools?|skills?)\b/i, "tries to change how other tools or skills are used"],
  [/\b(send|upload|post|exfiltrate|forward|transmit|copy)\b.{0,40}\b(secrets?|credentials?|tokens?|api keys?|passwords?|env(ironment)? var(iable)?s?|\.env|ssh keys?)\b.{0,60}(https?:\/\/|webhook|\b(remote|external|my) (server|url|endpoint)\b)/i, "asks the model to send secrets somewhere"],
  [/\b(disable|bypass|turn off|skip|ignore)\b.{0,20}\b(safety|guardrails?|permission (checks?|prompts?)|confirmations?|the sandbox|security (checks?|warnings?))\b/i, "tells the model to switch off safety checks"],
  [/--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b/i, "turns off the host's permission prompts"],
];

/** Mentions of files that hold credentials. Worth a look, though some skills have a good reason. */
export const CREDENTIAL_FILES = /(~|\$HOME|%USERPROFILE%)[\\/]\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc)\b|\bid_(rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials|\.git-credentials|\/etc\/shadow|\bkeychain\b/i;

/** Downloading code and running it straight away. */
export const REMOTE_CODE = /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b|\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*iex\b|base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh\b/i;

/** Claude Code runs !`command` and ```! blocks before the skill reaches the model. These commands deserve a closer look there. */
export const RISKY_COMMAND = /\b(curl|wget|nc|ncat|ssh|scp|rsync|sudo|rm\s+-[a-z]*r|base64|eval|printenv|env\b|cat\s+~|chmod\s+\+?7|dd\s+if=)/i;
