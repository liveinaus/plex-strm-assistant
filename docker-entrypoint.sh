#!/bin/sh
# On start: installs SQLite triggers into the Plex DB, then runs the proxy.
#
# First-run order:
#   1. docker compose up plex          -- let Plex initialise and create its DB
#   2. docker compose stop plex        -- MUST be stopped before trigger install
#   3. docker compose up strm-proxy    -- installs triggers, then starts proxy
#   4. docker compose start plex       -- start Plex again
#
# Subsequent restarts: set SKIP_SETUP=true to skip trigger installation and
# just start the proxy (safe while Plex is running).
#
# CRITICAL: never let Plex run concurrently with trigger installation --
# concurrent writes corrupt the SQLite DB.
set -e

DB="${DB_PATH:-/plex-db/com.plexapp.plugins.library.db}"
PROXY_BASE="http://${STRM_PROXY_HOST:-strm-proxy}:${PORT:-3000}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-/media/strm}"

if [ "${SKIP_SETUP:-false}" = "true" ]; then
  echo "[strm-proxy] SKIP_SETUP=true -- skipping trigger installation"
else
  # Wait for Plex to create the DB on first run (no timeout -- user controls when to proceed)
  if [ ! -f "$DB" ]; then
    echo "[strm-proxy] Waiting for Plex DB at $DB ..."
    echo "[strm-proxy] Start Plex once to let it initialise, then stop it and restart this container."
    until [ -f "$DB" ]; do sleep 5; done
    echo "[strm-proxy] DB found."
  fi

  echo "[strm-proxy] Installing triggers (db=$DB, proxy=$PROXY_BASE)..."
  node /app/dist/setup.js \
    --db "$DB" \
    --container-prefix "$CONTAINER_PREFIX" \
    --proxy-base "$PROXY_BASE"
fi

if [ "${GATEWAY_ENABLED:-false}" != "true" ]; then
  echo "[strm-proxy] Starting proxy..."
  exec node /app/dist/proxy.js
fi

# Gateway mode: reverse proxy in front of PMS that 302s direct-play .strm
# requests straight to the source, so streaming bypasses PMS entirely
echo "[strm-proxy] Starting gateway..."
node /app/dist/gateway.js &
gateway_pid=$!

echo "[strm-proxy] Starting proxy..."
node /app/dist/proxy.js &
proxy_pid=$!

stopping=""
trap 'stopping=1; kill -TERM "$gateway_pid" "$proxy_pid" 2>/dev/null || true' TERM INT

# wait -n is busybox ash and bash, not POSIX sh.
wait -n || true
[ -n "$stopping" ] || echo "[strm-proxy] a process exited -- stopping the container"
kill -TERM "$gateway_pid" "$proxy_pid" 2>/dev/null || true
wait || true
[ -n "$stopping" ] || exit 1
exit 0
