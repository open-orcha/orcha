#!/bin/sh
# Shell harness for deploy/provision-swap.sh. Everything that needs real
# root or a real Linux kernel (fallocate/mkswap/swapon/id) is stubbed via a
# PATH shim, so this runs anywhere (including macOS dev boxes / CI) without
# root, without touching real swap. Covers: fresh provisioning, idempotent
# no-op when swap is already active, duplicate-fstab guard on a re-run, the
# SIZE_GB override, and the polite non-Linux refusal (the real `uname`, not
# stubbed — this assertion only runs on non-Linux hosts; a Linux CI runner
# exercises the Linux paths above instead and skips this one).
#
# Run directly (sh tests/test_provision_swap.sh) or via the pytest wrapper
# tests/test_provision_swap_sh.py. Exits non-zero with a FAIL line on any
# assertion.
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_DIR/deploy/provision-swap.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_contains() { grep -qF -- "$2" "$1" || fail "$(basename "$1") missing: $2"; }

# ------------------------------------------------------------- stub binaries
# swapon/fallocate/mkswap/uname/id are all faked, so the Linux code paths run
# on any dev machine (incl. macOS) without root and without a real Linux
# kernel. `id` is faked so the harness can drive both the root and non-root
# branches without real privilege.
BIN="$TMP/bin"
mkdir -p "$BIN"
CALLS="$TMP/calls.log"
SWAPSTATE="$TMP/swap-state"   # non-empty when our stub considers swap "on"
: > "$CALLS"

cat > "$BIN/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = "-s" ] && echo "Linux"
EOF
chmod +x "$BIN/uname"

cat > "$BIN/swapon" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--show" ]; then
    [ -s "$SWAPSTATE" ] && cat "$SWAPSTATE"
    exit 0
fi
echo "swapon \$1" >> "$CALLS"
echo "\$1" > "$SWAPSTATE"
exit 0
EOF

cat > "$BIN/fallocate" <<EOF
#!/bin/sh
echo "fallocate \$*" >> "$CALLS"
shift; shift
touch "\$1"
exit 0
EOF

cat > "$BIN/mkswap" <<EOF
#!/bin/sh
echo "mkswap \$*" >> "$CALLS"
exit 0
EOF

chmod +x "$BIN/swapon" "$BIN/fallocate" "$BIN/mkswap"

FSTAB="$TMP/fstab"
SWAPFILE="$TMP/swapfile"

run_as() {
    # run_as <uid> -- runs the script with a faked `id` reporting <uid>.
    UID_VAL="$1"
    cat > "$BIN/id" <<EOF
#!/bin/sh
[ "\$1" = "-u" ] && echo "$UID_VAL"
EOF
    chmod +x "$BIN/id"
    env PATH="$BIN:$PATH" SWAPFILE="$SWAPFILE" \
        SIZE_GB="${SIZE_GB:-}" sh "$SCRIPT"
}

# The script hardcodes /etc/fstab; point it at our fake via sed on a scratch
# copy so the harness never touches the real file.
SCRIPT_UNDER_TEST="$TMP/provision-swap.sh"
sed 's#/etc/fstab#'"$FSTAB"'#g' "$SCRIPT" > "$SCRIPT_UNDER_TEST"
chmod +x "$SCRIPT_UNDER_TEST"
SCRIPT="$SCRIPT_UNDER_TEST"

: > "$FSTAB"

# ============================================================= fresh, root
OUT=$(run_as 0 2>&1) || { echo "$OUT"; fail "fresh root run exited non-zero"; }
echo "$OUT" | grep -q "^✓ 4GB swap active" || fail "fresh run missing success line: $OUT"
assert_contains "$CALLS" "fallocate -l 4G $SWAPFILE"
assert_contains "$CALLS" "mkswap $SWAPFILE"
assert_contains "$CALLS" "swapon $SWAPFILE"
assert_contains "$FSTAB" "$SWAPFILE none swap sw 0 0"
[ "$(stat -f%p "$SWAPFILE" 2>/dev/null || stat -c%a "$SWAPFILE" 2>/dev/null)" ] \
    || fail "swapfile not created"

# ==================================================== idempotent: swap is on
: > "$CALLS"
OUT=$(run_as 0 2>&1) || { echo "$OUT"; fail "idempotent run exited non-zero"; }
echo "$OUT" | grep -q "swap already active" || fail "idempotent run did not report existing swap: $OUT"
[ -s "$CALLS" ] && fail "idempotent run invoked fallocate/mkswap/swapon: $(cat "$CALLS")"

# ===================================== re-provision after swap drops, root
# Simulate a box where swap got deactivated but the file + fstab line
# persist (e.g. a filesystem that didn't honor the fstab entry on boot):
# duplicate fstab entries must never appear.
: > "$SWAPSTATE"
: > "$CALLS"
OUT=$(run_as 0 2>&1) || { echo "$OUT"; fail "re-provision run exited non-zero"; }
echo "$OUT" | grep -q "already present" || fail "re-provision did not report existing fstab entry: $OUT"
[ "$(grep -c "$SWAPFILE" "$FSTAB")" -eq 1 ] || fail "fstab entry duplicated on re-provision"

# ======================================================== non-root, no swap
: > "$SWAPSTATE"
: > "$CALLS"
if OUT=$(run_as 1000 2>&1); then
    fail "non-root run should have exited non-zero, got: $OUT"
fi
echo "$OUT" | grep -qi "root" || fail "non-root refusal message missing 'root': $OUT"

# ============================================================ SIZE_GB override
: > "$SWAPSTATE"
: > "$CALLS"
SIZE_GB=8
OUT=$(run_as 0 2>&1) || { echo "$OUT"; fail "SIZE_GB override run exited non-zero"; }
echo "$OUT" | grep -q "^✓ 8GB swap active" || fail "SIZE_GB override not honored: $OUT"
assert_contains "$CALLS" "fallocate -l 8G $SWAPFILE"
SIZE_GB=

# ================================================== non-Linux refusal (real uname)
# Uses the *real* `uname`, not the stub above, so this only exercises the
# refusal path on a non-Linux dev machine; on Linux CI it's a no-op assertion
# (the Linux paths above already cover that host).
if [ "$(uname -s)" != "Linux" ]; then
    OUT=$(env PATH="$PATH" SWAPFILE="$SWAPFILE" sh "$SCRIPT" 2>&1) \
        || fail "non-Linux run should exit 0, got rc=$? out=$OUT"
    echo "$OUT" | grep -qi "not Linux" || fail "non-Linux refusal message missing: $OUT"
fi

echo "OK: provision-swap shell harness passed"
