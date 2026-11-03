/**
 * Makes text from a skill, a plugin or a model safe to print in a terminal or a report.
 * Control characters (including ESC, so ANSI and OSC sequences such as clipboard writes or fake hyperlinks)
 * and bidirectional overrides are shown as visible \u escapes instead of being interpreted.
 * Newlines and tabs are kept.
 */
export function printable(s: unknown): string {
  return String(s ?? "").replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
