#!/usr/bin/env bash
# Re-render toolbar PNG icons from their SVG sources into extension/icons/.
# Requires rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")"
OUT="../../extension/icons"
for base in free limits paid abandoned unrated; do
  for size in 16 48 128; do
    rsvg-convert -w "$size" -h "$size" "$base.svg" -o "$OUT/$base$size.png"
  done
  echo "generated $base (16/48/128)"
done
