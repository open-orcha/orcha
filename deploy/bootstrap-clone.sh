#!/bin/sh
# Fresh-box bootstrap: clone orcha-cloud (private) via the GitHub App and
# install orcha-cli — no rsync, no PATs, no SSH deploy keys. Prereqs on the box:
#   - /opt/orcha-secrets/github-app.pem   (scp once from deploy/auth/, chmod 600)
#   - /opt/orcha-secrets/github-app.json  (from deploy/auth/, has the app "id")
#   - the app INSTALLED on the repo (app page → Install App → select repos)
# Usage:  sh bootstrap-clone.sh [owner/repo] [dest]
set -eu

REPO="${1:-Quantal-Labs-AI/orcha-cloud}"
DEST="${2:-/opt/orcha-cloud}"
SECRETS="${ORCHA_SECRETS_DIR:-/opt/orcha-secrets}"
APP_ID=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json'))['id'])")

# This script may run before the repo exists locally, so fetch the minter from
# the checkout if present, else expect it beside this script.
MINT="$(dirname "$0")/github-app-token.py"
[ -f "$MINT" ] || MINT="$DEST/deploy/github-app-token.py"

TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" --app-id "$APP_ID" --repo "$REPO")
if [ -d "$DEST/.git" ]; then
    git -C "$DEST" remote set-url origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
    git -C "$DEST" pull --ff-only
    git -C "$DEST" remote set-url origin "https://github.com/${REPO}.git"   # never persist the token
else
    git clone "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "$DEST"
    git -C "$DEST" remote set-url origin "https://github.com/${REPO}.git"
fi
echo "✓ ${REPO} → ${DEST} (token scrubbed from git config)"

command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv tool install --force "$DEST/orcha-cli" >/dev/null
echo "✓ $(orcha --version) installed"
