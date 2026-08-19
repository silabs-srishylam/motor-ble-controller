#!/usr/bin/env bash
# Start the Vite dev server without requiring pnpm on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE=""
for candidate in \
  node \
  /usr/share/cursor/resources/app/resources/helpers/node \
  "$HOME/.nvm/versions/node"/*/bin/node
do
  if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
    NODE="$(command -v "$candidate" 2>/dev/null || echo "$candidate")"
    break
  fi
done

# Expand nvm glob if needed
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  for candidate in "$HOME/.nvm/versions/node"/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "Error: Node.js not found." >&2
  echo "Install Node 20+, or open this project in Cursor (bundled Node works)." >&2
  exit 1
fi

if [[ ! -x "$ROOT/node_modules/vite/bin/vite.js" && ! -f "$ROOT/node_modules/vite/bin/vite.js" ]]; then
  echo "Error: dependencies missing. Run: npm install -g pnpm && pnpm install" >&2
  exit 1
fi

PORT="${PORT:-3000}"
echo "Starting Vite with: $NODE"
echo "Open on your Windows machine (do not use start-chrome-linux.sh over remote):"
echo "  http://localhost:${PORT}/motor-ble-controller/"
echo ""

exec "$NODE" "$ROOT/node_modules/vite/bin/vite.js" --host --port "$PORT"
