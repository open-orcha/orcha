#!/usr/bin/env python3
"""#289 (EFFICIENCY epic, measurement backbone) — repeatable control-project baseline.

WHY THIS EXISTS
    Per-wake runtime overhead (the prompt the daemon assembles, the rehydration, the inbox
    drain) is the signal we want to drive down. In THIS repo every wake also reads large chunks
    of orcha source for its task — a confound that swamps the overhead in the token totals. The
    fix is a *control project*: a separate Orcha container on a trivial non-orcha repo where the
    ONLY tokens are intrinsic per-wake overhead plus a tiny task. This script snapshots the
    `/api/containers/{cid}/token-usage` meter (Anvil #289) for that control container and diffs
    it against a prior snapshot, so we can prove a runtime fix actually moved the number.

    Fixes are still DEVELOPED in this repo (the only place orcha source exists to edit); the
    baseline + before/after validation RUN against the control container. See
    docs/orcha-efficiency-baseline.md for the standing-up runbook.

USAGE
    # snapshot the control container's meter and save a timestamped baseline
    python3 tools/efficiency/control_baseline.py snapshot \
        --api-base http://localhost:8003 --container <control-cid> --label pre-fix

    # diff two saved baselines (or the two most recent if none given)
    python3 tools/efficiency/control_baseline.py diff [pre.json post.json]

Stdlib only — no deps, runs anywhere Python 3.9+ does.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import pathlib
import sys
import urllib.error
import urllib.request

BASELINE_DIR = pathlib.Path(__file__).resolve().parent / "baselines"


def _get_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from {url}: {e.read().decode('utf-8', 'replace')[:300]}")
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"cannot reach {url}: {e}")


def _resolve_container(api_base: str, container: str | None) -> str:
    """Use the given cid, else auto-pick the single container on the stack (1:1:1 by design)."""
    if container:
        return container
    data = _get_json(f"{api_base}/api/containers")
    rows = data.get("containers", [])
    if len(rows) != 1:
        sys.exit(f"expected exactly 1 container on the stack, found {len(rows)} — pass --container")
    return rows[0]["id"]


def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def cmd_snapshot(args: argparse.Namespace) -> None:
    api_base = args.api_base.rstrip("/")
    cid = _resolve_container(api_base, args.container)
    usage = _get_json(f"{api_base}/api/containers/{cid}/token-usage")
    record = {
        "captured_at": _utc_stamp(),
        "label": args.label,
        "api_base": api_base,
        "container_id": cid,
        "usage": usage,
    }
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{record['captured_at']}{('-' + args.label) if args.label else ''}.json"
    out = BASELINE_DIR / fname
    out.write_text(json.dumps(record, indent=2) + "\n")

    w = usage.get("windows", {})
    print(f"baseline saved -> {out}")
    for win in ("5h", "7d", "all"):
        d = w.get(win, {})
        pct = d.get("pct_of_quota")
        pct_s = f"  ({pct}% of quota)" if pct is not None else ""
        print(f"  {win:>3}: {d.get('total_tokens', 0):>12,} tokens   "
              f"${d.get('total_cost_usd', 0):.4f}   {d.get('runs', 0)} wakes{pct_s}")


def _load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text())


def _two_recent() -> tuple[pathlib.Path, pathlib.Path]:
    files = sorted(BASELINE_DIR.glob("*.json"))
    if len(files) < 2:
        sys.exit(f"need >=2 baselines in {BASELINE_DIR} to diff (found {len(files)})")
    return files[-2], files[-1]


def cmd_diff(args: argparse.Namespace) -> None:
    if args.files:
        if len(args.files) != 2:
            sys.exit("diff takes exactly two baseline files (or none, to use the two most recent)")
        before, after = (pathlib.Path(f) for f in args.files)
    else:
        before, after = _two_recent()
    b, a = _load(before), _load(after)
    print(f"BEFORE {before.name}  (label={b.get('label')!r}, {b['usage'].get('windows', {}).get('all', {}).get('runs', 0)} wakes)")
    print(f"AFTER  {after.name}  (label={a.get('label')!r}, {a['usage'].get('windows', {}).get('all', {}).get('runs', 0)} wakes)")
    print("-" * 64)
    bw, aw = b["usage"].get("windows", {}), a["usage"].get("windows", {})
    fields = ("total_tokens", "input_tokens", "output_tokens",
              "cache_read_input_tokens", "cache_creation_input_tokens", "total_cost_usd")
    for win in ("5h", "7d", "all"):
        print(f"[{win}]")
        for f in fields:
            bv = bw.get(win, {}).get(f, 0) or 0
            av = aw.get(win, {}).get(f, 0) or 0
            delta = av - bv
            sign = "+" if delta >= 0 else ""
            if f == "total_cost_usd":
                print(f"  {f:<30} {bv:>12.4f} -> {av:>12.4f}   {sign}{delta:.4f}")
            else:
                print(f"  {f:<30} {bv:>12,} -> {av:>12,}   {sign}{delta:,}")
    # Per-wake mean over the 'all' window is the cleanest control signal.
    for tag, snap in (("BEFORE", b), ("AFTER", a)):
        allw = snap["usage"].get("windows", {}).get("all", {})
        runs = allw.get("runs", 0) or 0
        mean = (allw.get("total_tokens", 0) / runs) if runs else 0
        print(f"{tag} mean tokens/wake (all): {mean:,.0f}")


def main() -> None:
    p = argparse.ArgumentParser(description="Orcha #289 control-project token baseline")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("snapshot", help="capture + save a baseline from the token-usage meter")
    s.add_argument("--api-base", default="http://localhost:8003",
                   help="portal API base (default: http://localhost:8003)")
    s.add_argument("--container", default=None,
                   help="control container id (default: the single container on the stack)")
    s.add_argument("--label", default=None, help="tag this baseline, e.g. pre-fix / post-fix")
    s.set_defaults(func=cmd_snapshot)

    d = sub.add_parser("diff", help="diff two baselines (default: two most recent)")
    d.add_argument("files", nargs="*", help="before.json after.json (optional)")
    d.set_defaults(func=cmd_diff)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
