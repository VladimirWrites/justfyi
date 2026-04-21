#!/usr/bin/env bash
# Render screenshot + promo HTML sources to PNGs inside design/store/.
# Uses headless Chrome so Inter (via woff2) and CSS gradients/blur render
# the same way users see them.
set -euo pipefail
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT=".."

render() {
  local src="$1" out="$2" w="$3" h="$4"
  # --headless=new trims ~87px off the bottom of the viewport, which
  # leaves a transparent strip that stores render as white. Render into
  # an oversized window and crop back to the intended size.
  local pad_h=$((h + 120))
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --force-device-scale-factor=1 \
    --window-size="${w},${pad_h}" \
    --screenshot="$OUT/$out" \
    "file://$(pwd)/$src" >/dev/null 2>&1
  python3 - "$OUT/$out" "$w" "$h" <<'PY'
import sys
from PIL import Image
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path)
im.crop((0, 0, w, h)).save(path, optimize=True)
PY
  echo "→ $out (${w}×${h})"
}

render screenshot-paid.html    screenshot-1.png              1280 800
render screenshot-free.html    screenshot-2.png              1280 800
render screenshot-limits.html  screenshot-3.png              1280 800
render promo-marquee.html      promo-marquee-1400x560.png    1400 560
render promo-small.html        promo-small-440x280.png       440  280
echo "done"
