"""Turns captured ANSI terminal output into a dark terminal window as HTML, and prints its size in CSS pixels."""
import html, re, sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf8").read().rstrip("\n")
text = re.sub(r"\x1b\][^\x07]*\x07", "", text)  # window titles

COL = {"30": "#6e7681", "31": "#ff7b72", "32": "#7ee787", "33": "#e3b341", "34": "#79c0ff", "35": "#d2a8ff", "36": "#76e3ea", "37": "#e6edf3",
       "90": "#8b949e", "91": "#ffa198", "92": "#56d364", "93": "#f2cc60", "94": "#a5d6ff", "95": "#e2c5ff", "96": "#b3f0ff", "97": "#ffffff"}

def render(line):
    out, style, pos = [], {}, 0
    for m in re.finditer(r"\x1b\[([0-9;]*)m", line):
        out.append(span(line[pos:m.start()], style)); pos = m.end()
        for code in (m.group(1) or "0").split(";"):
            if code in ("0", ""): style = {}
            elif code == "1": style["b"] = 1
            elif code == "2": style["dim"] = 1
            elif code in COL: style["c"] = COL[code]
            elif code == "39": style.pop("c", None)
            elif code == "22": style.pop("b", None); style.pop("dim", None)
    out.append(span(line[pos:], style))
    return "".join(out)

def span(s, st):
    if not s: return ""
    css = []
    if "c" in st: css.append(f"color:{st['c']}")
    if "b" in st: css.append("font-weight:700")
    if "dim" in st: css.append("opacity:.6")
    s = html.escape(s)
    return f'<span style="{";".join(css)}">{s}</span>' if css else s

lines = text.split("\n")
plain = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in lines]
body = []
for i, l in enumerate(lines):
    if i == 0 and l.startswith("$ "):
        body.append(f'<span style="color:#7ee787">$</span> <span style="color:#e6edf3;font-weight:700">{html.escape(l[2:])}</span>')
    else:
        body.append(render(l))
cols = max(70, min(175, max(len(p) for p in plain)))
CH, LH, PAD, BAR = 8.9, 20, 22, 36
w = int(cols * CH + PAD * 2 + 48)
h = int(len(lines) * LH + PAD * 2 + BAR + 48)
open(dst, "w", encoding="utf8").write(f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;background:#010409;height:100%}}
.win{{margin:24px;width:max-content;background:#0d1117;border:1px solid #30363d;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}}
.bar{{height:{BAR}px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 14px;gap:8px}}
.bar i{{width:12px;height:12px;border-radius:50%;display:block}}
.bar b{{flex:1;text-align:center;color:#8b949e;font:600 12px system-ui,sans-serif;margin-right:52px}}
pre{{margin:0;padding:{PAD}px;color:#c9d1d9;font:14px/{LH}px "DejaVu Sans Mono",Menlo,Consolas,monospace;white-space:pre}}
</style><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>skillmedic</b></div>
<pre>{chr(10).join(body)}</pre></div>""")
print(w, h)
