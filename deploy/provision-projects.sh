#!/bin/sh
# Box-side project runtime provisioner — close the "portal-only project" gap.
#
# Projects created from the portal (POST /api/containers) exist ONLY in the stack
# DB: no workspace on disk, no notifier, so their agents never wake and chat never
# answers. This script (wired by provision-projects.timer, every 2 min) gives every
# portal container a runtime:
#
#   1. a workspace at $ORCHA_WORK_ROOT/<slug> (slug from the project name),
#      cloned from the bound GitHub repo when the container has one
#      (portal GET /api/containers → github_repo; token minted repo-scoped via
#      github-app-token.py, used once for the clone, then scrubbed from git
#      config — agents authenticate through the credential helper reading
#      .orcha/github-token, which github-token-refresh.timer keeps fresh);
#   2. <ws>/.claude/orcha.json binding the workspace to its container + the
#      loopback portal, sandbox ON with conservative caps
#      ($PROVISION_MEMORY/$PROVISION_CPUS, default 1536m / 1 cpu);
#   3. a registry line "<cid> <dir>" in $ORCHA_WORKSPACES_FILE
#      (default /opt/orcha-work/workspaces.list) — the box-wide source of truth
#      the other timers (github-token-refresh.sh) read instead of the legacy
#      $ORCHA_WORKSPACES env var;
#   4. a notifier daemon for the workspace. Two supervision paths, chosen per
#      tick (deploy/orcha-notifier@.service, issue #77):
#        - systemd present (orcha-notifier@.service installed in
#          $ORCHA_SYSTEMD_UNIT_DIR): `systemctl enable --now
#          orcha-notifier@<slug>` — the unit supervises restarts
#          (Restart=on-failure) and survives reboot on its own, so this pass
#          just makes sure the instance is enabled+active.
#        - otherwise (local self-host, no systemd, or the unit isn't
#          installed): the legacy path — env sourced from $ORCHA_DAEMON_ENV,
#          then `cd <ws> && orcha notifier --ensure`.
#      Both paths converge on the SAME idempotent-singleton daemon: pidfile
#      <ws>/.claude/.orcha-notifier.pid plus an atomic per-container claim in
#      ~/.orcha/notifier-<cid>.pid, written by the daemon itself regardless of
#      who launched it — so a systemd-started daemon reads as healthy to
#      `--ensure` (and vice versa), and the two paths never fight each other.
#
# Idempotent: re-runs skip registered containers, never touch existing
# workspaces, adopt pre-registry workspaces (e.g. the hand-built dogfood one)
# into the list, and re-ensure/re-enable a notifier for every registered
# workspace each tick (self-healing after a reboot). One log line per action.
#
# Env (all optional):
#   ORCHA_PORTAL_URL       portal base            (default http://127.0.0.1:8001)
#   ORCHA_WORK_ROOT        workspace parent dir   (default /opt/orcha-work)
#   ORCHA_WORKSPACES_FILE  registry file          (default $ORCHA_WORK_ROOT/workspaces.list)
#   ORCHA_SECRETS_DIR      GitHub App secrets     (default /opt/orcha-secrets)
#   ORCHA_DAEMON_ENV       notifier env file      (default /root/.orcha-daemon-env)
#   ORCHA_MINT             token minter script    (default <this dir>/github-app-token.py)
#   PROVISION_MEMORY       sandbox memory cap     (default 1536m)
#   PROVISION_CPUS         sandbox cpu cap        (default 1)
#   ORCHA_SYSTEMD_UNIT_DIR systemd unit dir       (default /etc/systemd/system)
set -eu

PORTAL="${ORCHA_PORTAL_URL:-http://127.0.0.1:8001}"
WORK_ROOT="${ORCHA_WORK_ROOT:-/opt/orcha-work}"
REGISTRY="${ORCHA_WORKSPACES_FILE:-$WORK_ROOT/workspaces.list}"
SECRETS="${ORCHA_SECRETS_DIR:-/opt/orcha-secrets}"
DAEMON_ENV="${ORCHA_DAEMON_ENV:-/root/.orcha-daemon-env}"
MINT="${ORCHA_MINT:-$(dirname "$0")/github-app-token.py}"
MEMORY="${PROVISION_MEMORY:-1536m}"
CPUS="${PROVISION_CPUS:-1}"
UNIT_DIR="${ORCHA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
# The stack network sandboxes must join. A cloned repo can carry its OWN
# .orcha/docker-compose.yml, making network derivation target a nonexistent
# network (wakes die 125) — so pin it explicitly. Auto-detect from the running
# portal container; PROVISION_NETWORK overrides.
NETWORK="${PROVISION_NETWORK:-}"
if [ -z "$NETWORK" ]; then
    PORTAL_CTR=$(docker ps --filter name=portal --format '{{.Names}}' | head -n 1)
    [ -n "$PORTAL_CTR" ] && NETWORK=$(docker inspect "$PORTAL_CTR"         --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
fi

# uv-installed `orcha` lives in ~/.local/bin, which systemd's default PATH lacks.
export PATH="${HOME:-/root}/.local/bin:$PATH"

mkdir -p "$WORK_ROOT"
[ -f "$REGISTRY" ] || : > "$REGISTRY"

registered() { # registered <cid> → 0 iff the container already has a registry line
    grep -q "^$1 " "$REGISTRY" 2>/dev/null
}

# ---- adopt pass: pre-registry workspaces (e.g. the hand-built dogfood one) ----
# Any $WORK_ROOT/<dir> carrying .claude/orcha.json with a container id joins the
# registry as-is, so the timers see it and the provision pass never shadows it.
for DIR in "$WORK_ROOT"/*/; do
    [ -f "${DIR}.claude/orcha.json" ] || continue
    CID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('current_container_id') or '')" \
          "${DIR}.claude/orcha.json" 2>/dev/null) || CID=""
    [ -n "$CID" ] || continue
    registered "$CID" && continue
    printf '%s %s\n' "$CID" "${DIR%/}" >> "$REGISTRY"
    echo "adopted existing workspace ${DIR%/} (container $CID)"
done

# ---- fetch the stack's containers: "<cid>\t<slug>\t<repo>" per line ----
CONTAINERS=$(python3 - "$PORTAL" <<'PYEOF'
import json, re, sys, urllib.request
portal = sys.argv[1]
try:
    with urllib.request.urlopen(f"{portal}/api/containers", timeout=10) as r:
        rows = json.loads(r.read()).get("containers") or []
except Exception as e:
    print(f"warn: portal unreachable at {portal} ({e}) — nothing to provision", file=sys.stderr)
    rows = []
for c in rows:
    cid = c.get("id") or ""
    if not cid:
        continue
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (c.get("name") or "").lower())).strip("-")
    slug = slug or f"project-{cid[:8]}"
    print(f"{cid}\t{slug}\t{c.get('github_repo') or ''}")
PYEOF
) || CONTAINERS=""

# install_token_file <dest> <content> — the 0640/uid-1000 contract sandboxes expect
# (same idiom as github-token-refresh.sh).
install_token_file() {
    TMP="$1.tmp"
    printf "%s" "$2" > "$TMP"
    chown 1000:1000 "$TMP" 2>/dev/null || true
    chmod 640 "$TMP"
    mv "$TMP" "$1"
}

provision_one() { # provision_one <cid> <slug> <repo-or-empty>
    P_CID=$1; P_SLUG=$2; P_REPO=$3
    WS="$WORK_ROOT/$P_SLUG"
    # Existing dir that ISN'T this container's (the adopt pass would have registered
    # a matching one): disambiguate with a cid prefix rather than ever touching it.
    if [ -e "$WS" ]; then
        WS="$WORK_ROOT/$P_SLUG-$(printf '%s' "$P_CID" | cut -c1-8)"
    fi
    if [ -e "$WS" ]; then
        echo "warn: $WS exists but is not registered to $P_CID — skipping" >&2
        return 0
    fi

    if [ -n "$P_REPO" ]; then
        APP_ID=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json'))['id'])" 2>/dev/null) || {
            echo "warn: no GitHub App credentials in $SECRETS — cannot clone $P_REPO for $P_CID (retry next tick)" >&2
            return 0
        }
        TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" --app-id "$APP_ID" \
                --repo "$P_REPO" 2>/dev/null) || TOKEN=""
        if [ -z "$TOKEN" ]; then
            echo "warn: token mint for $P_REPO failed (app installed on the repo?) — retry next tick" >&2
            return 0
        fi
        if ! git clone -q "https://x-access-token:${TOKEN}@github.com/${P_REPO}.git" "$WS"; then
            echo "warn: clone of $P_REPO failed — retry next tick" >&2
            rm -rf "$WS"
            return 0
        fi
        git -C "$WS" remote set-url origin "https://github.com/${P_REPO}.git"  # never persist the token
        # Sandboxed agents authenticate through the refreshed token file
        # (deploy/README.md). The sandbox mounts the workspace PATH-IDENTICALLY
        # and stamps ORCHA_WORKSPACE_ROOT; without the env (host mode) the
        # helper walks UP from $PWD — so a git-worktree cwd still resolves the
        # ROOT's .orcha/github-token.
        # shellcheck disable=SC2016  # everything must expand at CREDENTIAL time, not now
        git -C "$WS" config credential.helper \
            '!f() { d="${ORCHA_WORKSPACE_ROOT:-$PWD}"; while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -f "$d/.orcha/github-token" ]; do d=$(dirname "$d"); done; echo username=x-access-token; echo "password=$(cat "$d/.orcha/github-token")"; }; f'
        # Commits/PRs are authored by the app BOT, never a human account
        # (docs/agent-prs.md). Workspace-local config so agents inherit it.
        # The json slug is a creation-time snapshot — a later app RENAME makes it
        # stale — and GitHub links commits to the bot only via the bot USER id,
        # not the app id. Resolve both live; fall back to the snapshot/app id
        # (commit still lands, just unlinked from the bot avatar).
        BOT_SLUG=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json')).get('slug') or 'orcha-cloud-app')" 2>/dev/null) \
            || BOT_SLUG="orcha-cloud-app"
        BOT_UID=$(curl -fsS -H "Authorization: Bearer $TOKEN" \
            "https://api.github.com/users/${BOT_SLUG}%5Bbot%5D" 2>/dev/null \
            | python3 -c "import json,sys;print(json.load(sys.stdin).get('id') or '')" 2>/dev/null) || BOT_UID=""
        git -C "$WS" config user.name "${BOT_SLUG}[bot]"
        git -C "$WS" config user.email "${BOT_UID:-$APP_ID}+${BOT_SLUG}[bot]@users.noreply.github.com"
        mkdir -p "$WS/.orcha"
        # Seed the token we already minted so agents work before the first refresh tick.
        install_token_file "$WS/.orcha/github-token" "$TOKEN"
    else
        mkdir -p "$WS/.orcha"
        cat > "$WS/README.md" <<EOF
# $P_SLUG

Orcha workspace for portal project "$P_SLUG" (container $P_CID).

No GitHub repository is bound to this project yet — this workspace starts
empty. Connect a repo from the portal's GitHub panel; the box-side timers
mint and refresh its access token automatically.
EOF
    fi

    mkdir -p "$WS/.claude"
    python3 - "$WS/.claude/orcha.json" "$P_CID" "$PORTAL" "$P_SLUG" "$MEMORY" "$CPUS" "$NETWORK" <<'PYEOF'
import json, sys
path, cid, portal, slug, memory, cpus, network = sys.argv[1:8]
sandbox = {"enabled": True, "memory": memory, "cpus": cpus}
if network:
    sandbox["network"] = network
with open(path, "w") as fh:
    json.dump({
        "api_base_url": portal,
        "project_name": slug,
        "current_container_id": cid,
        "sandbox": sandbox,
    }, fh, indent=2)
    fh.write("\n")
PYEOF
    chown -R 1000:1000 "$WS" 2>/dev/null || true
    printf '%s %s\n' "$P_CID" "$WS" >> "$REGISTRY"
    echo "provisioned $WS (container $P_CID${P_REPO:+, repo $P_REPO})"
}

# ---- provision pass: every portal container missing from the registry ----
printf '%s\n' "$CONTAINERS" | while IFS="$(printf '\t')" read -r CID SLUG REPO; do
    [ -n "$CID" ] || continue
    registered "$CID" && continue
    provision_one "$CID" "$SLUG" "$REPO" || echo "warn: provisioning $CID failed" >&2
done

# ---- notifier pass: one idempotent-singleton daemon per registered workspace ----
# issue #77: prefer systemd supervision (Restart=on-failure + reboot-persistent)
# when the template unit is installed; fall back to the nohup `--ensure` path
# otherwise (local self-host boxes, or a systemd box mid-migration that hasn't
# installed the unit yet). Both paths write the SAME pidfile/heartbeat/claim
# (orcha_cli/notifier_daemon_registry.py), so they never fight: a
# systemd-started daemon reads as healthy to `--ensure`, and `--ensure`'s
# nohup daemon is just as supervisable as any other process to a human who
# later installs the unit — the only thing systemd adds is who's watching.
SYSTEMD_UNIT="$UNIT_DIR/orcha-notifier@.service"
have_systemd() {
    command -v systemctl >/dev/null 2>&1 && [ -f "$SYSTEMD_UNIT" ]
}

while read -r CID WS; do
    [ -n "${WS:-}" ] && [ -d "$WS" ] || continue
    INSTANCE=$(basename "$WS")
    if have_systemd; then
        UNIT="orcha-notifier@${INSTANCE}.service"
        # is-enabled/is-active both no-op fast when already true — cheap to
        # call every tick, and it's how the unit self-heals after a reboot
        # (systemd itself restarts a crashed instance; this just makes sure
        # the instance exists and is enabled for NEW workspaces this tick).
        if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
            :  # already supervised — nothing to do this tick
        elif systemctl enable --now "$UNIT" >/dev/null 2>&1; then
            echo "notifier: enabled+started $UNIT"
        else
            echo "warn: systemctl enable --now $UNIT failed for $WS" >&2
        fi
    else
        (
            # shellcheck disable=SC1090
            [ -f "$DAEMON_ENV" ] && . "$DAEMON_ENV" || true
            cd "$WS" && orcha notifier --ensure --quiet
        ) || echo "warn: notifier --ensure failed for $WS" >&2
    fi
done < "$REGISTRY"
