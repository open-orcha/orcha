#!/bin/sh
# Sync the portal's member roster into the OAuth perimeter allowlist.
# The portal is the source of truth for WHO is a member (owners invite via the
# Members UI); the proxy allowlist is the hard door. This bridges them: read
# members (bearer lane), rewrite ALLOWED_GITHUB_USERS in deploy/auth/.env, and
# restart oauth2-proxy only when the roster actually changed.
# Wired by sync-members.timer (every 2 min). Env:
#   ORCHA_PORTAL_URL   (default http://127.0.0.1:8001)
#   ORCHA_AUTH_DIR     (default /opt/orcha-cloud/deploy/auth)
set -eu

PORTAL="${ORCHA_PORTAL_URL:-http://127.0.0.1:8001}"
AUTH="${ORCHA_AUTH_DIR:-/opt/orcha-cloud/deploy/auth}"

# Union the rosters of ALL projects in the stack — an invite on any project
# must open the door (field bug: reading only containers[0] stranded invitees).
LOGINS=$(python3 - "$PORTAL" <<'PYEOF'
import json, sys, urllib.request
portal = sys.argv[1]
def get(path):
    with urllib.request.urlopen(portal + path, timeout=10) as r:
        return json.loads(r.read())
logins = set()
for c in get("/api/containers")["containers"]:
    for m in get(f"/api/containers/{c['id']}/members")["members"]:
        if m.get("github_login"):
            logins.add(m["github_login"].lower())
print(",".join(sorted(logins)))
PYEOF
)
[ -z "$LOGINS" ] && { echo "no member logins yet — leaving allowlist untouched"; exit 0; }

CURRENT=$(grep "^ALLOWED_GITHUB_USERS=" "$AUTH/.env" | cut -d= -f2- || true)
if [ "$CURRENT" = "$LOGINS" ]; then
    exit 0
fi
sed -i "s|^ALLOWED_GITHUB_USERS=.*|ALLOWED_GITHUB_USERS=$LOGINS|" "$AUTH/.env"
cd "$AUTH" && docker compose --env-file .env -f docker-compose.auth.yml -f oauth2-proxy-host.yml up -d oauth2-proxy >/dev/null 2>&1
echo "allowlist updated: $LOGINS"
