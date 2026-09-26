#!/bin/sh
# Thin, idempotent wrapper around the local-run happy path:
#   orcha init   (only if .orcha/ doesn't exist yet in this directory)
#   orcha up     (always — safe to re-run; `docker compose up -d` is idempotent)
#
# Usage:  sh deploy/local/up.sh        (run from the project directory you want
#                                        Orcha initialized in, e.g. a fresh
#                                        `mkdir myproj && cd myproj`)
#
# See deploy/local/README.md for the full guide (GitHub PAT, optional OAuth
# overlay, troubleshooting). This script only automates steps 1–2 of the
# TL;DR there; it does not install Docker, orcha-cli, or set up OAuth.
set -eu

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found on PATH." >&2
    echo "  Install Docker Desktop, OrbStack, or Colima, then re-run this script." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "error: docker is installed but not running (or not reachable)." >&2
    echo "  Start Docker Desktop / OrbStack / Colima, then re-run this script." >&2
    exit 1
fi

if ! command -v orcha >/dev/null 2>&1; then
    echo "error: orcha not found on PATH." >&2
    echo "  Install it with:" >&2
    echo "    uv tool install --from <path-to-orcha-cloud-checkout>/orcha-cli orcha-cli" >&2
    echo "  (uv itself: curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2
    exit 1
fi

if [ -d .orcha ]; then
    echo "[up.sh] .orcha/ already present — skipping 'orcha init', running 'orcha up' ..."
    orcha up
else
    echo "[up.sh] no .orcha/ here — running 'orcha init' (this also brings the stack up) ..."
    orcha init
fi

# .claude/orcha.json is written by `orcha init` (and left untouched by `orcha
# up`) with the port this project's portal is bound to — read it back instead
# of assuming 8000, since a second project on the same machine shifts up.
PORTAL_URL=""
if [ -f .claude/orcha.json ]; then
    PORTAL_URL=$(python3 -c "
import json
try:
    print(json.load(open('.claude/orcha.json')).get('api_base_url', ''))
except Exception:
    pass
" 2>/dev/null || true)
fi

echo
if [ -n "$PORTAL_URL" ]; then
    echo "[up.sh] portal: $PORTAL_URL"
else
    echo "[up.sh] portal is up — check .claude/orcha.json for its URL (default http://localhost:8000)."
fi
echo "[up.sh] next: open the portal URL above, then Settings -> GitHub access to paste a PAT."
echo "[up.sh] re-run this script anytime; it never re-inits or wipes data."
