#!/bin/sh
# Shell harness for the systemd branch of deploy/provision-projects.sh's
# notifier pass (issue #77). Focused: skips the portal/clone machinery
# (test_provision_projects.sh covers that) and drives the notifier pass
# directly against a hand-built registry, with `systemctl` PATH-shimmed to
# log its argv instead of touching the real service manager.
#
# Asserts: (1) with the template unit "installed" (a stub file at
# $ORCHA_SYSTEMD_UNIT_DIR/orcha-notifier@.service) and systemctl on PATH, the
# notifier pass enables+starts orcha-notifier@<slug> per registered workspace
# instead of running `orcha notifier --ensure`; (2) a workspace whose unit is
# already active is left alone (no redundant enable --now, just an
# is-active probe) — the idempotent-per-tick contract; (3) without the unit
# file installed, the pass falls back to the legacy `orcha notifier --ensure`
# path untouched.
#
# Run directly (sh tests/test_provision_projects_systemd.sh) or via the
# pytest wrapper tests/test_provision_sh.py.
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
PROV="$REPO_DIR/deploy/provision-projects.sh"

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

# ---- stub portal (empty container list — this harness drives the registry
# directly, so the provision pass has nothing to do; only the notifier pass
# at the end of the script is under test here) ----
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
cat > "$TMP/portal.py" <<'EOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/containers":
            body = json.dumps({"containers": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
python3 "$TMP/portal.py" "$PORT" &
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
export SYSTEMCTL_LOG="$TMP/systemctl.log" ORCHA_LOG="$TMP/orcha.log"
: > "$SYSTEMCTL_LOG"; : > "$ORCHA_LOG"

# systemctl stub: `is-active` reports active only for units named in
# $ACTIVE_UNITS (space-separated, env-passed); `enable --now` always
# "succeeds" and logs. Anything else is a no-op success.
cat > "$BIN/systemctl" <<'EOF'
#!/bin/sh
echo "$@" >> "$SYSTEMCTL_LOG"
case "$1" in
    is-active)
        unit="$3"
        [ "${3:-}" = "--quiet" ] && unit="$4"
        for u in ${ACTIVE_UNITS:-}; do
            [ "$u" = "$unit" ] && exit 0
        done
        exit 3
        ;;
    *) exit 0 ;;
esac
EOF
chmod +x "$BIN/systemctl"

# orcha stub for the legacy fallback path — must NOT be invoked for a
# workspace served by systemd.
cat > "$BIN/orcha" <<'EOF'
#!/bin/sh
echo "cwd=$PWD args=$*" >> "$ORCHA_LOG"
exit 0
EOF
chmod +x "$BIN/orcha"

# --------------------------------------------------------------- environment
WORK="$TMP/work"
UNIT_DIR="$TMP/systemd-units"
mkdir -p "$WORK/site-a/.claude" "$WORK/site-b/.claude" "$WORK/site-c/.claude" "$TMP/home"
for ws in site-a site-b site-c; do
    cat > "$WORK/$ws/.claude/orcha.json" <<EOF
{"api_base_url": "http://127.0.0.1:$PORT", "current_container_id": "cid-$ws"}
EOF
done
REGISTRY="$WORK/workspaces.list"
cat > "$REGISTRY" <<EOF
cid-site-a $WORK/site-a
cid-site-b $WORK/site-b
cid-site-c $WORK/site-c
EOF

run_prov() {
    env HOME="$TMP/home" PATH="$BIN:$PATH" \
        ORCHA_PORTAL_URL="http://127.0.0.1:$PORT" \
        ORCHA_WORK_ROOT="$WORK" \
        ORCHA_WORKSPACES_FILE="$REGISTRY" \
        ORCHA_SYSTEMD_UNIT_DIR="$UNIT_DIR" \
        "$@" \
        sh "$PROV"
}

# ============================================== 1. no unit installed → legacy
run_prov > "$TMP/legacy.log" 2>&1 || { cat "$TMP/legacy.log" >&2; fail "run (no unit) exited non-zero"; }
for ws in site-a site-b site-c; do
    assert_contains "$ORCHA_LOG" "cwd=$WORK/$ws args=notifier --ensure --quiet"
done
assert_not_contains "$SYSTEMCTL_LOG" "orcha-notifier@"

# ============================================ 2. unit installed → systemd path
mkdir -p "$UNIT_DIR"
: > "$UNIT_DIR/orcha-notifier@.service"
: > "$ORCHA_LOG"; : > "$SYSTEMCTL_LOG"

run_prov ACTIVE_UNITS="orcha-notifier@site-b.service" \
    > "$TMP/systemd.log" 2>&1 || { cat "$TMP/systemd.log" >&2; fail "run (systemd) exited non-zero"; }

# site-a and site-c aren't active yet → enabled+started
assert_contains "$SYSTEMCTL_LOG" "enable --now orcha-notifier@site-a.service"
assert_contains "$SYSTEMCTL_LOG" "enable --now orcha-notifier@site-c.service"
assert_contains "$TMP/systemd.log" "notifier: enabled+started orcha-notifier@site-a.service"
assert_contains "$TMP/systemd.log" "notifier: enabled+started orcha-notifier@site-c.service"

# site-b already active → probed, left alone, no redundant enable --now
assert_contains "$SYSTEMCTL_LOG" "is-active --quiet orcha-notifier@site-b.service"
assert_not_contains "$SYSTEMCTL_LOG" "enable --now orcha-notifier@site-b.service"

# the legacy nohup path must NOT run for any workspace once systemd is available
assert_not_contains "$ORCHA_LOG" "notifier --ensure"

# ======================================= 3. idempotent per tick (second run)
: > "$SYSTEMCTL_LOG"
run_prov ACTIVE_UNITS="orcha-notifier@site-a.service orcha-notifier@site-b.service orcha-notifier@site-c.service" \
    > "$TMP/systemd2.log" 2>&1 || { cat "$TMP/systemd2.log" >&2; fail "run (systemd, all active) exited non-zero"; }
assert_not_contains "$SYSTEMCTL_LOG" "enable --now"
for ws in site-a site-b site-c; do
    assert_contains "$SYSTEMCTL_LOG" "is-active --quiet orcha-notifier@$ws.service"
done

echo "OK: provision-projects systemd-branch harness passed"
