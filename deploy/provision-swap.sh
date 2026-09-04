#!/bin/sh
# Provision a swapfile so an overload degrades gracefully instead of
# thrashing the box to death. Field motivation: a production OOM (six
# sandboxes spawned in 11s, global OOM killed an in-sandbox npm ci) hit a
# swapless box and the kernel thrashed (CPU 200%, ~1GB/s disk reads) until an
# operator power-cycled it. A 4GB swapfile was added by hand during recovery;
# this script makes that step idempotent and part of the bootstrap.
#
# Sizing: 4GB default. Rough concurrency-cap math — sandbox wakes are capped
# around ~1.5GB RSS each (PROVISION_MEMORY, see deploy/README.md); a few GB
# of swap buys the box time to shed load (OOM killer / operator) instead of
# hard-locking when a burst of wakes briefly exceeds physical RAM. Override
# with SIZE_GB for boxes with more headroom or a higher concurrency cap.
#
# Idempotent: if ANY swap is already active (per `swapon --show`, so this
# also respects a pre-existing swap partition, not just our swapfile), this
# exits 0 with a message and does nothing. Safe to re-run from bootstrap.
#
# Usage:  sh provision-swap.sh
# Env:    SIZE_GB   swapfile size in GiB (default 4)
set -eu

SIZE_GB="${SIZE_GB:-4}"
SWAPFILE="${SWAPFILE:-/swapfile}"

if [ "$(uname -s)" != "Linux" ]; then
    echo "provision-swap: not Linux ($(uname -s)) — swapfiles are a Linux concept, skipping"
    exit 0
fi

if [ -n "$(swapon --show 2>/dev/null)" ]; then
    echo "provision-swap: swap already active — nothing to do"
    swapon --show
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "provision-swap: needs root (fallocate/mkswap/swapon/fstab) — re-run with sudo/root" >&2
    exit 1
fi

echo "provision-swap: no active swap — creating ${SIZE_GB}GB at $SWAPFILE"

if command -v fallocate >/dev/null 2>&1; then
    fallocate -l "${SIZE_GB}G" "$SWAPFILE"
else
    # Fallback for filesystems/kernels where fallocate isn't supported (e.g. some
    # overlay/network filesystems reject it with EOPNOTSUPP).
    echo "provision-swap: fallocate unavailable — falling back to dd (slower)"
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$((SIZE_GB * 1024))" status=none
fi

chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE" >/dev/null
swapon "$SWAPFILE"

# fstab persistence — guard against duplicate entries on re-run.
FSTAB_LINE="$SWAPFILE none swap sw 0 0"
if ! grep -qsF "$SWAPFILE" /etc/fstab; then
    echo "$FSTAB_LINE" >> /etc/fstab
    echo "provision-swap: added fstab entry"
else
    echo "provision-swap: fstab entry for $SWAPFILE already present — left untouched"
fi

echo "✓ ${SIZE_GB}GB swap active at $SWAPFILE (persisted in /etc/fstab)"
