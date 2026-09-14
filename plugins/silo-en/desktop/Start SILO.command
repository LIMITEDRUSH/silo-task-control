#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
else
  printf '%s\n' "SILO requires Node.js 22.5 or newer." >&2
  printf '%s\n' "Install Node.js, then open this launcher again." >&2
  read -r _answer
  exit 1
fi

if ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)'; then
  printf '%s\n' "SILO requires Node.js 22.5 or newer." >&2
  read -r _answer
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/launch.mjs"
