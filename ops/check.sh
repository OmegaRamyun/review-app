#!/usr/bin/env bash
# check.sh — the loop's gate for every unit: typecheck + frontend build + Rust build.
# Exit code is the verdict (the conductor never greps output).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source ops/env.sh
echo "== typecheck + vite build"; npm run --silent build
echo "== cargo build (debug, Linux webkit2gtk compile gate; the target is Windows/WebView2)"
(cd src-tauri && cargo build --quiet)
echo "check OK"
