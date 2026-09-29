#!/usr/bin/env bash
# Build the standalone single-file Web UI without requiring pnpm on PATH.
# Output: dist/public/index.html
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/node-env.sh
source "$ROOT/scripts/node-env.sh"

if [[ ! -f "$ROOT/node_modules/vite/bin/vite.js" ]]; then
  echo "Error: dependencies missing. Run: ./scripts/setup.sh" >&2
  exit 1
fi

echo "Building standalone HTML with: $NODE ($("$NODE" --version))"
"$NODE" "$ROOT/node_modules/vite/bin/vite.js" build
echo ""
echo "Standalone HTML: $ROOT/dist/public/index.html"
