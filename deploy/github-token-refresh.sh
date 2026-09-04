#!/bin/sh
# Keep fresh GitHub installation tokens in each Orcha workspace so SANDBOXED
# agents can pull/push/PR as the app bot. The app's PEM stays on the host —
# containers only ever see the 1-hour tokens via the workspace mount.
#
# Wired by a systemd timer (github-token-refresh.timer, every 40 min). Reads
# the workspace list from the provisioner's registry file (lines "<cid> <dir>",
# $ORCHA_WORKSPACES_FILE, default /opt/orcha-work/workspaces.list — maintained
# by provision-projects.sh). When the registry doesn't exist yet (pre-provisioner
# boxes), falls back to the legacy $ORCHA_WORKSPACES env var (space-separated
# project dirs).
#
# Multi-org: the app may be installed on SEVERAL orgs/users. Per workspace this
# writes TWO files into <ws>/.orcha:
#   github-token        — the legacy single token agents read via the git
#                         credential helper. If the workspace's container is
#                         bound to a repo (portal GET /api/containers/{cid}/github,
#                         cid from <ws>/.claude/orcha.json), it is minted with
#                         --repo so the OWNER-matched installation is used and
#                         the token is scoped to that repo; unbound → first
#                         installation, as before.
#   github-tokens.json  — {"<owner-lowercase>": "<token>", ...} covering ALL
#                         installations, for the PORTAL's multi-org repo listing
#                         (ORCHA_GITHUB_TOKENS_FILE).
#
# Inside a workspace's repo, agents authenticate through the standard git
# credential helper installed by setup (see deploy/README.md; the sandbox
# mounts the workspace path-identically and stamps ORCHA_WORKSPACE_ROOT):
#   git config credential.helper \
#     '!f() { d="${ORCHA_WORKSPACE_ROOT:-$PWD}"; while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -f "$d/.orcha/github-token" ]; do d=$(dirname "$d"); done; echo username=x-access-token; echo "password=$(cat "$d/.orcha/github-token")"; }; f'
# and can open PRs with:
#   curl -H "Authorization: Bearer $(cat "$ORCHA_WORKSPACE_ROOT/.orcha/github-token")" ...
set -eu

SECRETS="${ORCHA_SECRETS_DIR:-/opt/orcha-secrets}"
APP_ID=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json'))['id'])")
MINT="${ORCHA_MINT:-$(dirname "$0")/github-app-token.py}"
PORTAL="${ORCHA_PORTAL_URL:-http://127.0.0.1:8001}"

# install_token_file <dest> <content> — atomic write (tmp + rename) with the
# 0640/uid-1000 contract sandboxes expect.
install_token_file() {
    TMP="$1.tmp"
    printf "%s" "$2" > "$TMP"
    chown 1000:1000 "$TMP" 2>/dev/null || true
    chmod 640 "$TMP"
    mv "$TMP" "$1"
}

# ---- one per-owner token map for ALL installations (same for every workspace) ----
TOKENS_JSON=$(python3 - "$MINT" "$SECRETS/github-app.pem" "$APP_ID" <<'PYEOF'
import json, subprocess, sys
mint, pem, app_id = sys.argv[1], sys.argv[2], sys.argv[3]
def run(*extra):
    return subprocess.run([sys.executable, mint, "--pem", pem, "--app-id", app_id, *extra],
                          capture_output=True, text=True)
tokens = {}
listing = run("--list-installations")
if listing.returncode == 0:
    for inst in json.loads(listing.stdout or "[]"):
        if not inst.get("owner"):
            continue
        minted = run("--installation-id", str(inst["id"]))
        if minted.returncode == 0 and minted.stdout.strip():
            tokens[inst["owner"].lower()] = minted.stdout.strip()
        else:
            print(f"warn: mint failed for installation {inst['id']} ({inst['owner']})",
                  file=sys.stderr)
print(json.dumps(tokens))
PYEOF
) || TOKENS_JSON="{}"

# Workspace list: the provisioner's registry when present (2nd column of
# "<cid> <dir>" lines), else the legacy env var.
WSFILE="${ORCHA_WORKSPACES_FILE:-/opt/orcha-work/workspaces.list}"
if [ -f "$WSFILE" ]; then
    WORKSPACES=$(awk 'NF >= 2 {print $2}' "$WSFILE")
else
    WORKSPACES="${ORCHA_WORKSPACES:-/opt/orcha-work/dogfood}"
fi

for WS in $WORKSPACES; do
    [ -d "$WS/.orcha" ] || continue

    # Which repo (if any) is this workspace's container bound to? cid comes from
    # <ws>/.claude/orcha.json; the portal answers over loopback. Any failure
    # (no file, no cid, portal down) → empty → legacy first-installation mint.
    REPO=$(python3 - "$WS" "$PORTAL" <<'PYEOF'
import json, pathlib, sys, urllib.request
ws, portal = sys.argv[1], sys.argv[2]
try:
    cfg = json.loads((pathlib.Path(ws) / ".claude" / "orcha.json").read_text())
    cid = cfg.get("current_container_id")
    if cid:
        with urllib.request.urlopen(f"{portal}/api/containers/{cid}/github", timeout=10) as r:
            print(json.loads(r.read()).get("repo") or "")
except Exception:
    pass
PYEOF
) || REPO=""

    TOKEN=""
    if [ -n "$REPO" ]; then
        TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" --app-id "$APP_ID" \
                --repo "$REPO" 2>/dev/null) || {
            echo "warn: bound mint for $WS ($REPO) failed — falling back to first installation" >&2
            TOKEN=""; }
    fi
    [ -n "$TOKEN" ] || TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" \
            --app-id "$APP_ID" 2>/dev/null) || {
        echo "warn: token mint failed for $WS (app not installed yet?)" >&2; continue; }
    install_token_file "$WS/.orcha/github-token" "$TOKEN"
    echo "refreshed $WS/.orcha/github-token${REPO:+ (bound: $REPO)}"

    # Portal-facing multi-org map (skip when empty so the portal falls back to
    # the single token above rather than reading an empty map).
    if [ "$TOKENS_JSON" != "{}" ] && [ -n "$TOKENS_JSON" ]; then
        install_token_file "$WS/.orcha/github-tokens.json" "$TOKENS_JSON"
        echo "refreshed $WS/.orcha/github-tokens.json"
    fi
done
