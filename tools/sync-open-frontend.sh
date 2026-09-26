#!/usr/bin/env bash
# Sync the open-orcha React frontend into Orcha Cloud (see
# docs/orcha-cloud-react-architecture.md). Cloud-owned seams are never touched:
#   frontend/src/extensions.ts, frontend/src/cloud/**
# Usage: tools/sync-open-frontend.sh [/path/to/open-orcha-checkout]
set -euo pipefail

OPEN="${1:-../Orcha}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$OPEN/orcha-cli/orcha_cli/templates/portal"
DST="$HERE/orcha-cli/orcha_cli/templates/portal"

[ -d "$SRC/frontend/src" ] || { echo "open checkout not found at: $SRC" >&2; exit 1; }

echo "== syncing frontend/ (preserving Cloud seams)"
rsync -a --delete \
  --exclude node_modules \
  --exclude src/extensions.ts \
  --exclude "src/cloud/" \
  --exclude src/foundation.extensions.test.ts \
  "$SRC/frontend/" "$DST/frontend/"

echo "== syncing static/vendor/"
rsync -a --delete "$SRC/static/vendor/" "$DST/static/vendor/"

echo "== syncing open styles.css -> styles/open-base.css (the base layer under the cloud skin)"
cp "$SRC/static/styles.css" "$DST/static/styles/open-base.css"

cd "$DST/frontend"
echo "== install (lockfile may have changed)"
npm install --no-audit --no-fund >/dev/null

echo "== verify + rebuild dist"
npx tsc --noEmit
npx vitest run
npm run build

echo "== done. Review 'git status', run the cloud pytest suite, then commit."
