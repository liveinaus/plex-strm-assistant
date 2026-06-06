#!/usr/bin/env bash
# One-time setup: installs auto-patch triggers into the Plex database.
# After this, no further patching is needed -- Plex rescans and new .strm
# files are handled automatically by the triggers.
#
# Usage:  ./scripts/setup-triggers.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

DB="$ROOT/plex-config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"

if [[ ! -f "$DB" ]]; then
  echo "Plex database not found -- has Plex started and completed initial setup?"
  exit 1
fi

# PROXY_BASE is built from STRM_PROXY_HOST / STRM_PROXY_PORT --
# the same vars set on the plex service in docker-compose.yml.
# Must be an address reachable by browser clients doing direct play.
STRM_PROXY_HOST="${STRM_PROXY_HOST:-strm-proxy}"
STRM_PROXY_PORT="${STRM_PROXY_PORT:-3000}"
PROXY_BASE="http://${STRM_PROXY_HOST}:${STRM_PROXY_PORT}"

ARGS=(
  --db "$DB"
  --container-prefix "/media/strm"
  --proxy-base "$PROXY_BASE"
)

if [[ " $* " == *" --dry-run "* ]]; then
  node --experimental-sqlite "$ROOT/dist/setup.js" "${ARGS[@]}" --dry-run
  exit 0
fi

echo "Stopping Plex..."
docker compose -f "$ROOT/docker-compose.yml" stop plex

node --experimental-sqlite "$ROOT/dist/setup.js" "${ARGS[@]}"

echo "Starting Plex..."
docker compose -f "$ROOT/docker-compose.yml" start plex
