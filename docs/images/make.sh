#!/usr/bin/env bash
# Rebuilds the README screenshots from the test fixtures. Needs Node, Python 3 and Chrome or Chromium.
# Usage: npm run build && bash docs/images/make.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=docs/images
TMP=$(mktemp -d)
CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}
CLI="node dist/cli.js"

# Runs a command in a pseudo-terminal so skillmedic prints colour, and saves the output.
capture() { local name=$1; shift; printf '$ skillmedic %s\n' "$*" > "$TMP/$name.ans"; script -qec "$CLI $*" /dev/null | sed 's/\r$//' >> "$TMP/$name.ans" || true; }

capture check check test/fixtures/bad --no-hosts
capture hosts hosts
capture eval eval test/fixtures/eval/cases.yaml test/fixtures/eval --model mock --repeat 2
capture fix fix test/fixtures/eval/cases.yaml test/fixtures/eval --model mock --repeat 2
$CLI check test/fixtures/bad --html "$TMP/report.html" --fail-on never > /dev/null

shot() { # html file, png, width, height
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-dark-mode --enable-features=WebContentsForceDark:false \
    --force-device-scale-factor=2 --window-size="$3,$4" --screenshot="$2" "file://$1" 2>/dev/null
}

for f in "$TMP"/*.ans; do
  name=$(basename "$f" .ans)
  python3 docs/images/ansi2html.py "$f" "$TMP/$name.html" > "$TMP/$name.size"
  read -r w h < "$TMP/$name.size"
  shot "$TMP/$name.html" "$OUT/$name.png" "$w" "$h"
done
shot "$TMP/report.html" "$OUT/report.png" 1100 900
ls -la "$OUT"/*.png
