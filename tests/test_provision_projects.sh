#!/bin/sh
# Shell harness for deploy/provision-projects.sh (+ the github-token-refresh.sh
# registry migration). Everything external is stubbed: the portal is a local
# python http.server, `git`/`orcha` are PATH shims that log their argv, and the
# token minter is a stub .py selected via ORCHA_MINT. Asserts workspace
# creation, registry contents, orcha.json shape, clone-with-scrubbed-token,
# notifier ensure (with daemon env sourced), idempotency, and that the refresh
# timer reads the new registry file (with the legacy env-var fallback intact).
#
# Run directly (sh tests/test_provision_projects.sh) or via the pytest wrapper
# tests/test_provision_sh.py. Exits non-zero with a FAIL line on any assertion.
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
PROV="$REPO_DIR/deploy/provision-projects.sh"
REFRESH="$REPO_DIR/deploy/github-token-refresh.sh"

TMP=$(mktemp -d)
SRV_PID=""
cleanup() {
    [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_contains() { grep -qF -- "$2" "$1" || fail "$(basename "$1") missing: $2"; }
assert_not_contains() { grep -qF -- "$2" "$1" && fail "$(basename "$1") unexpectedly contains: $2" || true; }

# ---------------------------------------------------------------- stub portal
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
cat > "$TMP/containers.json" <<'EOF'
[
  {"id": "cid-dogfood-0000", "name": "dogfood", "github_repo": null},
  {"id": "cid-1111", "name": "My Site!", "github_repo": "acme/site"},
  {"id": "cid-2222", "name": "Docs Project", "github_repo": null}
]
EOF
cat > "$TMP/portal.py" <<'EOF'
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

containers = json.load(open(sys.argv[2]))

class H(BaseHTTPRequestHandler):
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/containers":
            return self._json({"containers": containers})
        m = re.match(r"^/api/containers/([^/]+)/github$", self.path)
        if m:
            for c in containers:
                if c["id"] == m.group(1):
                    return self._json({"repo": c.get("github_repo")})
        self.send_error(404)

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
python3 "$TMP/portal.py" "$PORT" "$TMP/containers.json" &
SRV_PID=$!
python3 - "$PORT" <<'EOF' || fail "stub portal did not come up"
import sys, time, urllib.request
for _ in range(50):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/api/containers", timeout=1)
        sys.exit(0)
    except Exception:
        time.sleep(0.1)
sys.exit(1)
EOF

# ------------------------------------------------------------- stub binaries
BIN="$TMP/bin"
mkdir -p "$BIN"
export GIT_LOG="$TMP/git.log" ORCHA_LOG="$TMP/orcha.log" MINT_LOG="$TMP/mint.log"
: > "$GIT_LOG"; : > "$ORCHA_LOG"; : > "$MINT_LOG"

cat > "$BIN/git" <<'EOF'
#!/bin/sh
echo "$@" >> "$GIT_LOG"
if [ "${1:-}" = "clone" ]; then
    for arg in "$@"; do dest="$arg"; done
    mkdir -p "$dest/.git"
fi
exit 0
EOF
cat > "$BIN/orcha" <<'EOF'
#!/bin/sh
echo "cwd=$PWD args=$* daemon_var=${FAKE_DAEMON_VAR:-unset}" >> "$ORCHA_LOG"
exit 0
EOF
chmod +x "$BIN/git" "$BIN/orcha"

cat > "$TMP/mint.py" <<'EOF'
import json, os, sys
log = os.environ.get("MINT_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(" ".join(sys.argv[1:]) + "\n")
if "--list-installations" in sys.argv:
    print(json.dumps([{"id": 1, "owner": "acme"}]))
else:
    print("ghs_FAKETOKEN123")
EOF

# --------------------------------------------------------------- environment
WORK="$TMP/work"
SECRETS="$TMP/secrets"
mkdir -p "$WORK" "$SECRETS" "$TMP/home"
echo '{"id": 999}' > "$SECRETS/github-app.json"
echo "fake-pem" > "$SECRETS/github-app.pem"
echo 'export FAKE_DAEMON_VAR=from-daemon-env' > "$TMP/daemon-env"

# A pre-registry, hand-built workspace (the dogfood case) that must be ADOPTED,
# never re-provisioned.
mkdir -p "$WORK/dogfood/.claude" "$WORK/dogfood/.orcha"
cat > "$WORK/dogfood/.claude/orcha.json" <<'EOF'
{"api_base_url": "http://localhost:8001", "current_container_id": "cid-dogfood-0000"}
EOF

# HOME is isolated so the provisioner's ~/.local/bin PATH prepend can't pull in
# a real `orcha`, and the stub PATH shim wins.
run_prov() {
    env HOME="$TMP/home" PATH="$BIN:$PATH" \
        ORCHA_PORTAL_URL="http://127.0.0.1:$PORT" \
        ORCHA_WORK_ROOT="$WORK" \
        ORCHA_SECRETS_DIR="$SECRETS" \
        ORCHA_DAEMON_ENV="$TMP/daemon-env" \
        ORCHA_MINT="$TMP/mint.py" \
        PROVISION_MEMORY="2048m" PROVISION_CPUS="2" \
        sh "$PROV"
}

# ================================================================ first run
run_prov > "$TMP/run1.log" 2>&1 || { cat "$TMP/run1.log" >&2; fail "provisioner run 1 exited non-zero"; }

REGISTRY="$WORK/workspaces.list"
[ -f "$REGISTRY" ] || fail "registry file not created"

# adoption: the hand-built workspace joined the registry untouched
assert_contains "$TMP/run1.log" "adopted existing workspace $WORK/dogfood (container cid-dogfood-0000)"
assert_contains "$REGISTRY" "cid-dogfood-0000 $WORK/dogfood"

# bound project: cloned via a repo-scoped token, then the token scrubbed
[ -d "$WORK/my-site" ] || fail "bound workspace my-site not created"
assert_contains "$GIT_LOG" "clone -q https://x-access-token:ghs_FAKETOKEN123@github.com/acme/site.git $WORK/my-site"
assert_contains "$GIT_LOG" "-C $WORK/my-site remote set-url origin https://github.com/acme/site.git"
assert_contains "$GIT_LOG" "config credential.helper"
# path-identical mounting: the helper resolves the token via the sandbox-stamped
# ORCHA_WORKSPACE_ROOT (with a $PWD walk-up fallback) — never a /workspace remap
assert_contains "$GIT_LOG" 'ORCHA_WORKSPACE_ROOT'
assert_contains "$GIT_LOG" '/.orcha/github-token'
assert_not_contains "$GIT_LOG" "/workspace/.orcha/github-token"
# agent→PR bot identity: workspace-local git config authors commits as the app
# bot (stub secrets carry no slug → the orcha-cloud-app fallback), email built
# from the secrets' APP_ID (999 in the stub).
assert_contains "$GIT_LOG" "-C $WORK/my-site config user.name orcha-cloud-app[bot]"
assert_contains "$GIT_LOG" "-C $WORK/my-site config user.email 999+orcha-cloud-app[bot]@users.noreply.github.com"
assert_contains "$MINT_LOG" "--repo acme/site"
[ "$(cat "$WORK/my-site/.orcha/github-token")" = "ghs_FAKETOKEN123" ] || fail "seed token not installed"
assert_contains "$REGISTRY" "cid-1111 $WORK/my-site"
assert_contains "$TMP/run1.log" "provisioned $WORK/my-site (container cid-1111, repo acme/site)"

# unbound project: empty workspace with an explanatory README, no git calls
[ -d "$WORK/docs-project/.orcha" ] || fail "unbound workspace docs-project/.orcha not created"
assert_contains "$WORK/docs-project/README.md" "No GitHub repository is bound"
assert_not_contains "$GIT_LOG" "docs-project"
assert_contains "$REGISTRY" "cid-2222 $WORK/docs-project"

# orcha.json shape (binding + loopback portal + sandbox caps from env overrides)
python3 - "$WORK/my-site/.claude/orcha.json" "http://127.0.0.1:$PORT" <<'EOF' || fail "my-site orcha.json shape wrong"
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg["current_container_id"] == "cid-1111", cfg
assert cfg["api_base_url"] == sys.argv[2], cfg
assert cfg["project_name"] == "my-site", cfg
assert cfg["sandbox"] == {"enabled": True, "memory": "2048m", "cpus": "2"}, cfg
EOF
python3 - "$WORK/docs-project/.claude/orcha.json" <<'EOF' || fail "docs-project orcha.json shape wrong"
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg["current_container_id"] == "cid-2222", cfg
assert cfg["sandbox"]["enabled"] is True, cfg
EOF

# notifier ensured for ALL THREE registered workspaces, with the daemon env sourced
for ws in dogfood my-site docs-project; do
    grep -F "cwd=$WORK/$ws " "$ORCHA_LOG" | grep -qF "args=notifier --ensure --quiet" \
        || fail "notifier --ensure did not run in $ws"
done
assert_contains "$ORCHA_LOG" "daemon_var=from-daemon-env"

# ============================================================== second run (idempotency)
cp "$REGISTRY" "$TMP/registry.run1"
GIT_LINES_1=$(wc -l < "$GIT_LOG")

run_prov > "$TMP/run2.log" 2>&1 || { cat "$TMP/run2.log" >&2; fail "provisioner run 2 exited non-zero"; }

cmp -s "$REGISTRY" "$TMP/registry.run1" || fail "registry changed on an idempotent re-run"
[ "$(wc -l < "$GIT_LOG")" -eq "$GIT_LINES_1" ] || fail "git invoked again on an idempotent re-run"
assert_not_contains "$TMP/run2.log" "provisioned "
assert_not_contains "$TMP/run2.log" "adopted "
# ...but the notifier self-heal pass still ran for every workspace
[ "$(grep -c "args=notifier --ensure --quiet" "$ORCHA_LOG")" -eq 6 ] || fail "expected 6 ensure calls over two runs"

# ==================================================== refresh reads the registry
# Delete a provisioned token, point the legacy env var somewhere bogus, and run
# github-token-refresh.sh: it must find the workspaces through the REGISTRY (the
# env var is ignored when the file exists) and re-mint the bound repo's token.
rm -f "$WORK/my-site/.orcha/github-token"
: > "$MINT_LOG"
env HOME="$TMP/home" PATH="$BIN:$PATH" \
    ORCHA_PORTAL_URL="http://127.0.0.1:$PORT" \
    ORCHA_SECRETS_DIR="$SECRETS" \
    ORCHA_WORKSPACES_FILE="$REGISTRY" \
    ORCHA_WORKSPACES="$TMP/nonexistent-legacy-path" \
    ORCHA_MINT="$TMP/mint.py" \
    sh "$REFRESH" > "$TMP/refresh.log" 2>&1 || { cat "$TMP/refresh.log" >&2; fail "refresh run exited non-zero"; }
[ "$(cat "$WORK/my-site/.orcha/github-token")" = "ghs_FAKETOKEN123" ] || fail "refresh did not re-mint via the registry"
assert_contains "$MINT_LOG" "--repo acme/site"
assert_contains "$TMP/refresh.log" "refreshed $WORK/my-site/.orcha/github-token (bound: acme/site)"
assert_contains "$TMP/refresh.log" "refreshed $WORK/dogfood/.orcha/github-token"
[ -d "$TMP/nonexistent-legacy-path" ] && fail "refresh touched the legacy env-var path despite the registry" || true

# Legacy fallback: with NO registry file, $ORCHA_WORKSPACES still works.
rm -f "$WORK/docs-project/.orcha/github-token"
env HOME="$TMP/home" PATH="$BIN:$PATH" \
    ORCHA_PORTAL_URL="http://127.0.0.1:$PORT" \
    ORCHA_SECRETS_DIR="$SECRETS" \
    ORCHA_WORKSPACES_FILE="$TMP/no-such-registry" \
    ORCHA_WORKSPACES="$WORK/docs-project" \
    ORCHA_MINT="$TMP/mint.py" \
    sh "$REFRESH" > "$TMP/refresh2.log" 2>&1 || { cat "$TMP/refresh2.log" >&2; fail "refresh fallback run exited non-zero"; }
[ "$(cat "$WORK/docs-project/.orcha/github-token")" = "ghs_FAKETOKEN123" ] || fail "env-var fallback broken"

echo "OK: provision-projects shell harness passed"
