import { printable } from "./sanitize.js";
import type { Report } from "./report.js";
import type { Severity } from "./types.js";

const esc = (s: unknown) => printable(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COLOUR: Record<Severity, string> = { error: "#c62828", warning: "#b26a00", info: "#1565c0" };
/** Only https links become anchors, so a hostile source cannot add a javascript: link. */
const link = (u: string) => (/^https:\/\//.test(u) ? `<a href="${esc(u)}">Source</a>` : "");

/** A single self-contained HTML page with no scripts or outside requests. */
export function formatHtml(r: Report): string {
  const rows = r.findings.map((f) => `<tr>
  <td><span class="sev" style="background:${COLOUR[f.severity]}">${esc(f.severity)}</span></td>
  <td><code>${esc(f.rule)}</code>${f.host ? ` <span class="muted">${esc(f.host)}</span>` : ""}</td>
  <td>${esc(f.skill ?? "")}${f.file ? `<div><code>${esc(f.file)}${f.line ? `:${f.line}` : ""}</code></div>` : ""}</td>
  <td>${esc(f.message)}${f.fix ? `<div class="fix">Fix: ${esc(f.fix)}</div>` : ""}${f.source ? `<div class="src">${link(f.source)}</div>` : ""}</td>
</tr>`).join("\n");
  const max = Math.max(1, ...r.skills.map((t) => t.listingTokens));
  const bars = [...r.skills].sort((a, b) => b.listingTokens - a.listingTokens).slice(0, 20)
    .map((t) => `<div class="bar"><span>${esc(t.name)}</span><i style="width:${(t.listingTokens / max) * 100}%"></i><b>${t.listingTokens}</b></div>`).join("\n");
  const s = r.summary;
  const grade = s.score >= 90 ? "#2e7d32" : s.score >= 70 ? "#b26a00" : "#c62828";
  return `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>skillmedic report: ${esc(r.root)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:24px;color:#1b1b1b}
h1{font-size:22px;margin:0 0 4px}.muted{color:#666}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;min-width:110px}
.card b{display:block;font-size:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
.sev{color:#fff;border-radius:4px;padding:1px 6px;font-size:12px}.fix{color:#2e7d32;margin-top:4px}.src{font-size:13px}
.bar{display:grid;grid-template-columns:220px 1fr 60px;gap:8px;align-items:center;margin:3px 0}.bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar i{display:block;height:10px;background:#90a4ae;border-radius:3px}code{font-size:13px;word-break:break-all}
:root{color-scheme:light dark}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.muted{color:#8b949e}.card{border-color:#30363d;background:#161b22}
td,th{border-color:#21262d}.fix{color:#56d364}a{color:#58a6ff}.bar i{background:#58a6ff}}
</style></head><body>
<h1>skillmedic report: ${esc(r.root)}</h1>
<div class="muted">Checked by skillmedic ${esc(r.version)}${r.hostPack ? `, host rules ${esc(r.hostPack)}` : ""}</div>
${r.truncated ? `<p><b>Stopped early at the file limit, so some skills may be missing.</b></p>` : ""}
<div class="cards">
<div class="card">Score<b style="color:${grade}">${s.score}/100</b></div>
<div class="card">Skills<b>${s.skills}</b></div>
<div class="card">Plugins<b>${s.plugins}</b></div>
<div class="card">Listings<b>${s.listingTokens.toLocaleString("en-NZ")}</b>tokens</div>
<div class="card">Errors<b>${s.errors}</b></div>
<div class="card">Warnings<b>${s.warnings}</b></div>
<div class="card">Notes<b>${s.infos}</b></div>
</div>
<h2>Findings</h2>
${r.findings.length ? `<table><thead><tr><th>Level</th><th>Check</th><th>Skill</th><th>What and how to fix it</th></tr></thead><tbody>\n${rows}\n</tbody></table>` : "<p>No findings.</p>"}
<h2>Listing cost by skill</h2>
${bars || "<p>No skills.</p>"}
<p class="muted">The name and description of every skill go into each conversation. Token figures are estimates at about 4 characters per token.</p>
</body></html>
`;
}

/** A shields.io endpoint badge: https://shields.io/badges/endpoint-badge */
export function badgeJson(r: Report): string {
  const s = r.summary.score;
  const color = s >= 90 ? "brightgreen" : s >= 70 ? "yellow" : s >= 50 ? "orange" : "red";
  return JSON.stringify({ schemaVersion: 1, label: "skillmedic", message: `${s}/100`, color }, null, 2) + "\n";
}
