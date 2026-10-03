"""``orcha worktrees`` — see, save and clean up the agent worktrees of a project.

    orcha worktrees [list]                 classify every worktree under .orcha-worktrees
    orcha worktrees clean --dry-run        show exactly what a clean-up would do (changes nothing)
    orcha worktrees clean                  clean → removed; has output → output saved (to its task,
                                           else .orcha/saved-output/<branch>/), then removed;
                                           unmerged → kept (--unmerged PATH removes that worktree
                                           but keeps its branch); in use → skipped
    orcha worktrees remove PATH [--keep-branch] [--confirm-unmerged BRANCH]
    orcha worktrees save-output PATH

All of it runs ``worktree_gc`` (the notifier's implementation). ``--json`` prints one JSON
object (the desktop app calls this). The portal is used when it answers (running runs count as
"in use", output is attached to the task, removals are logged as project events); without it
everything still works offline (process check only, output copied to saved-output).
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Optional

from . import notifier_worktree_gc as ngc
from . import worktree_gc as gc


def register(sub, handler) -> None:
    p = sub.add_parser(
        "worktrees",
        help="list / clean up the agent worktrees under .orcha-worktrees (use --dry-run first)",
    )
    p.add_argument("action", nargs="?", default="list",
                   choices=("list", "clean", "remove", "save-output"))
    p.add_argument("path", nargs="?", default=None, help="worktree path (remove / save-output)")
    p.add_argument("--project", default=None, help="project folder (default: current folder)")
    p.add_argument("--dry-run", action="store_true", help="clean: report the plan, change nothing")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--only-clean", action="store_true",
                   help="clean: leave worktrees with output alone")
    p.add_argument("--unmerged", action="append", default=[], metavar="PATH",
                   help="clean: also remove this unmerged worktree (its branch is kept)")
    p.add_argument("--keep-branch", action="store_true", help="remove: keep the branch")
    p.add_argument("--confirm-unmerged", default=None, metavar="BRANCH",
                   help="remove: required for a worktree with unmerged commits (its branch name)")
    p.add_argument("--offline", action="store_true", help="don't contact the portal")
    p.set_defaults(func=handler)


def _project_root(start: Optional[str]) -> pathlib.Path:
    here = pathlib.Path(start or ".").resolve()
    # Run from inside a worktree → act on the main checkout it belongs to.
    for cand in (here, *here.parents):
        if cand.name == gc.WORKTREES_DIR:
            return cand.parent
    code, top = gc.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], str(here))
    if code == 0 and top.strip().endswith("/.git"):
        return pathlib.Path(top.strip()).parent
    return here


def _portal(root: pathlib.Path, offline: bool):
    if offline:
        return None, None
    try:
        cfg = json.loads((root / ".claude" / "orcha.json").read_text())
    except (OSError, ValueError):
        return None, None
    api = (cfg.get("api_base_url") or "").rstrip("/")
    cid = cfg.get("current_container_id")
    if not api or not cid:
        return None, None
    return api, cid


def _busy_from_portal(api, cid) -> Optional[set]:
    if not api:
        return set()
    res = ngc._default_post(f"{api}/api/containers/{cid}/agent-worktrees/claim",
                            {"claimed_by": "orcha worktrees (cli)", "peek": True})
    if not isinstance(res, dict):
        return None
    return {p for p in (res.get("busy_worktrees") or []) if p}


def _print_rows(rows):
    order = {s: i for i, s in enumerate((gc.STATE_CLEAN, gc.STATE_HAS_OUTPUT, gc.STATE_UNMERGED,
                                         gc.STATE_IN_USE, gc.STATE_NOT_QUORATE))}
    for row in sorted(rows, key=lambda r: (order.get(r["state"], 9), r["name"])):
        age = row.get("age_seconds")
        age_s = f"{age // 3600}h" if isinstance(age, int) else "?"
        print(f"  {row['state']:<11} {row['name']:<46} {gc.human_bytes(row.get('size_bytes')):>9} "
              f"{age_s:>5}  {row.get('reason')}")
        for path in (row.get("output") or [])[:5] + (row.get("modified") or [])[:5]:
            print(f"      · {path}")
        extra = row.get("output_count", 0) + row.get("modified_count", 0) - min(
            5, len(row.get("output") or [])) - min(5, len(row.get("modified") or []))
        if extra > 0:
            print(f"      · …and {extra} more")


def cmd_worktrees(args) -> None:
    root = _project_root(args.project)
    api, cid = _portal(root, args.offline)
    busy = _busy_from_portal(api, cid)
    if busy is None:  # configured portal didn't answer → offline, process check only
        api, cid, busy = None, None, set()
    rows = gc.inventory(str(root), busy=busy, measure=True)
    if rows is None:
        msg = f"{root} is not a git checkout"
        print(json.dumps({"ok": False, "error": msg}) if args.json else f"error: {msg}")
        sys.exit(1)
    contexts = ngc.fetch_context(api, cid, rows) if api else {}
    for row in rows:
        ctx = contexts.get(row["path"]) or {}
        row["task_id"] = ctx.get("task_id")
        row["task_status"] = ctx.get("task_status")
        row["task_title"] = ctx.get("task_title")
    upload = ngc.upload_deliverable(api) if api else None

    if args.action == "list":
        if args.json:
            print(json.dumps({"ok": True, "project": str(root), "portal": bool(api), "items": rows,
                              "reclaimable_bytes": gc.reclaimable_bytes(rows)}))
            return
        print(f"Agent worktrees in {root}  ({len(rows)}; "
              f"{gc.human_bytes(gc.reclaimable_bytes(rows))} reclaimable)")
        _print_rows(rows)
        return

    if args.action == "clean":
        result = ngc.bulk_clean(str(root), rows, contexts, busy,
                                include_output=not args.only_clean,
                                unmerged_paths=args.unmerged, api_base=api, cid=cid,
                                quiet=True, upload=upload, dry_run=args.dry_run, trigger="cli")
        if args.json:
            print(json.dumps({"ok": True, "project": str(root), **result}))
            return
        verb = "Would remove" if args.dry_run else "Removed"
        print(f"{verb} {len(result['removed'])} worktree(s), "
              f"{gc.human_bytes(result['freed_bytes'])}"
              + (" (dry run — nothing changed)" if args.dry_run else ""))
        for e in result["removed"]:
            print(f"  - {e['name']:<46} {e['state']:<11} {gc.human_bytes(e.get('size_bytes')):>9}"
                  + ("  (branch kept)" if e.get("keep_branch") else ""))
            saves = e.get("saves") or []
            for p in saves[:8]:
                print(f"      saves · {p}")
            if len(saves) > 8:
                print(f"      saves · …and {len(saves) - 8} more")
            pres = e.get("preserved") or {}
            if pres.get("attached") or pres.get("saved"):
                print(f"      {len(pres.get('attached') or [])} attached to the task, "
                      f"{len(pres.get('saved') or [])} copied to {pres.get('saved_to') or '-'}")
        for e in result["kept"]:
            print(f"  = kept    {e['name']:<40} {e.get('reason')}")
        for e in result["skipped"]:
            print(f"  = skipped {e['name']:<40} {e.get('reason')}")
        return

    if not args.path:
        print("error: give the worktree path", file=sys.stderr)
        sys.exit(2)
    target = str(pathlib.Path(args.path).resolve())
    row = next((r for r in rows if gc._real(r["path"]) == gc._real(target)), None)
    if row is None:
        out = {"ok": False, "error": "not an agent worktree of this project"}
    elif args.action == "save-output":
        kept = gc.preserve_output(str(root), row, task_id=row.get("task_id"), upload=upload)
        out = {"ok": not kept["failed"], **kept}
    else:
        confirm = args.confirm_unmerged
        if row["state"] == gc.STATE_UNMERGED and confirm != row["branch"]:
            out = {"ok": False, "error": f"it has unmerged commits — pass --confirm-unmerged "
                                         f"{row['branch']} (add --keep-branch to keep them)"}
        else:
            res = gc.remove_worktree(str(root), row["path"], busy=busy,
                                     allow_unmerged=row["state"] == gc.STATE_UNMERGED,
                                     keep_branch=args.keep_branch, task_id=row.get("task_id"),
                                     upload=upload)
            if api:
                ngc.report_event(api, cid, res, "cli")
            out = {"ok": res["outcome"] == "removed", **res}
    if args.json:
        print(json.dumps(out))
    else:
        print(("ok: " if out.get("ok") else "not done: ")
              + (out.get("reason") or out.get("error") or json.dumps(out)))
    if not out.get("ok") and not args.json:  # --json callers read "ok" (the desktop app)
        sys.exit(1)
