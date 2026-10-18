#!/usr/bin/env bash
# setup-libs.sh — Download all vendored dependencies into ./libs/
# Run once: bash setup-libs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBS_DIR="$SCRIPT_DIR/libs"

mkdir -p "$LIBS_DIR"

declare -A DOWNLOADS=(
  ["pdf-lib.min.js"]="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"
  ["pdf.min.mjs"]="https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.min.mjs"
  ["pdf.worker.min.mjs"]="https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs"
  ["jszip.min.js"]="https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"
  ["heic2any.min.js"]="https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js"
  ["UTIF.js"]="https://unpkg.com/utif@3.1.0/UTIF.js"
  ["xlsx.full.min.js"]="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
)

for name in "${!DOWNLOADS[@]}"; do
  dest="$LIBS_DIR/$name"
  url="${DOWNLOADS[$name]}"
  if [ -f "$dest" ]; then
    echo "[SKIP] $name already exists."
  else
    echo "[DOWN] Downloading $name..."
    if curl -fsSL -o "$dest" "$url"; then
      echo "[DONE] $name"
    else
      echo "[FAIL] $name from $url"
    fi
  fi
done

echo ""
echo "All libraries downloaded to $LIBS_DIR"
