"""`orcha qa ...`: the QA command group (docs/orcha-qa-plan.md).

- `orcha qa doctor`: the `[qa]` extra, idb_companion, `xcrun simctl`, adb, booted simulators,
  adb devices, device locks, Playwright and its Chromium, the portal, the acting agent, and
  whether QA is on for the project.
- `orcha qa mcp`: run the `orcha-qa` MCP tool server on stdio (what agents launch).
- `orcha qa map build --platform ios|android|web [--repo PATH]`: read the app's code into the map
  (`codemap.build_payload`, then `POST /map/import`).
- `orcha qa targets [--platform P] [--app-id ID] [--device NAME]`: list the QA targets, or set one
  (setting is human-only on the portal).
- `orcha qa enable` / `orcha qa disable`: give the project's agents the QA tools (`launch.py`).
- `orcha qa request [--task ID] [--kind K] [--platform P] ...`: hand work to QA (no device, no extra).

Only the standard library is imported here: `orcha --help` works without the extra.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any, Callable, Optional

PLATFORMS = ("ios", "android", "web")
KINDS = ("map", "explore", "draft", "check", "triage")
VIEWPORTS = ("desktop", "mobile")
EXTRA_MODULES = (("mcp", "mcp>=2.2"), ("idb", "fb-idb"), ("uiautomator2", "uiautomator2"), ("adbutils", "adbutils"), ("PIL", "pillow"),
                 ("playwright", "playwright"))


def register(sub: Any, handler: Callable[[Any], Any]) -> None:
    qa = sub.add_parser("qa", help="QA tools: map, explore and draft scenarios on an iOS simulator, an Android "
                                   "emulator or a web app in Chromium (doctor | mcp | map build | targets | enable | disable | request)")
    qsub = qa.add_subparsers(dest="qa_cmd", required=True)

    doc = qsub.add_parser("doctor", help="check the QA prerequisites: the [qa] extra, idb_companion, simctl, adb, "
                                         "devices, the portal and the acting agent")
    doc.add_argument("--json", action="store_true", help="machine-readable output")
    doc.set_defaults(func=handler)

    pt = qsub.add_parser("phone-tools", help="install Appium and its XCUITest driver in ~/.orcha/tools, to drive physical iPhones")
    pt.set_defaults(func=handler)

    m = qsub.add_parser("mcp", help="run the orcha-qa MCP tool server on stdio (agents launch this)")
    m.set_defaults(func=handler)

    mp = qsub.add_parser("map", help="the app map")
    msub = mp.add_subparsers(dest="map_cmd", required=True)
    mb = msub.add_parser("build", help="read the app's code into the map (POST /map/import)")
    mb.add_argument("--platform", required=True, choices=PLATFORMS)
    mb.add_argument("--repo", default=None, help="the app's repository (default: the current folder)")
    mb.add_argument("--dry-run", action="store_true", help="print the counts, send nothing")
    mb.add_argument("--json", action="store_true", help="machine-readable output")
    mb.set_defaults(func=handler)

    t = qsub.add_parser("targets", help="list the QA targets, or set one with --app-id/--device (human only)")
    t.add_argument("--platform", choices=PLATFORMS, default=None)
    t.add_argument("--app-id", default=None, help="bundle id (iOS), package (Android) or start URL (web)")
    t.add_argument("--device", default=None, help="the default simulator / emulator name; on the web the viewport: desktop | mobile")
    t.add_argument("--app-name", default=None)
    t.add_argument("--build-path", default=None, help="a .app / .apk to install (optional)")
    t.add_argument("--notes", default=None, help="sign-in identity hints for agents (never a password); on the web an "
                                                 "`Allowed: https://other.origin` line lets agents open that origin too")
    t.add_argument("--json", action="store_true", help="machine-readable output")
    t.set_defaults(func=handler)

    rq = qsub.add_parser("request", help="hand work to QA: files a QA request and its task for the project's QA agent")
    rq.add_argument("--task", default=None, help="the task QA tests (default: none; the result comes back to you)")
    rq.add_argument("--kind", choices=KINDS, default=None, help="default: check with approved scenarios, else explore")
    rq.add_argument("--finding", action="append", default=[], metavar="ID", help="triage: a finding to diagnose (repeatable)")
    rq.add_argument("--platform", choices=PLATFORMS, default=None)
    rq.add_argument("--scenario", action="append", default=[], metavar="ID", help="a scenario to check (repeatable)")
    rq.add_argument("--tag", action="append", default=[], help="check the scenarios with this tag (repeatable)")
    rq.add_argument("--focus", default=None, help="what to look at first")
    rq.add_argument("--acceptance", action="append", default=[], metavar="LINE",
                    help="a line to prove (repeatable; default: the task's definition of done)")
    rq.add_argument("--minutes", type=int, default=None, help="time budget of a map or explore session")
    rq.add_argument("--branch", default=None)
    rq.add_argument("--commit", default=None)
    rq.add_argument("--url", default=None, help="where the build under test runs")
    rq.add_argument("--app-path", default=None, help="a .app / .apk to test")
    rq.add_argument("--build-notes", default=None, help="anything else about the build")
    rq.add_argument("--on-fail", choices=("report", "reopen"), default=None,
                    help="reopen: a failure sends the task back with the findings (default: the project's setting)")
    rq.add_argument("--json", action="store_true", help="machine-readable output")
    rq.set_defaults(func=handler)

    en = qsub.add_parser("enable", help="give this project's agents the orcha-qa tools")
    en.set_defaults(func=handler)
    dis = qsub.add_parser("disable", help="take the orcha-qa tools away from this project's agents")
    dis.set_defaults(func=handler)


def cmd_qa(args: Any) -> None:
    cmd = getattr(args, "qa_cmd", None)
    if cmd == "doctor":
        code = cmd_doctor(args)
    elif cmd == "phone-tools":
        code = cmd_phone_tools(args)
    elif cmd == "mcp":
        from .mcp_server import run

        code = run()
    elif cmd == "map":
        code = cmd_map_build(args)
    elif cmd == "request":
        code = cmd_request(args)
    elif cmd == "targets":
        code = cmd_targets(args)
    elif cmd == "enable":
        code = cmd_enable(args)
    elif cmd == "disable":
        code = cmd_disable(args)
    else:
        print("usage: orcha qa doctor | mcp | map build | targets | enable | disable", file=sys.stderr)
        code = 2
    if code:
        raise SystemExit(code)


# ---------- helpers ----------


def _run(cmd: list[str], timeout: float = 10.0) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(cmd)} timed out"
    except OSError as e:
        return 1, str(e)


def booted_simulators() -> tuple[Optional[list[dict[str, str]]], str]:
    """(booted simulators [{name, udid, runtime}], problem). None when simctl is unusable."""
    if not shutil.which("xcrun"):
        return None, "xcrun not found (install Xcode)"
    code, out = _run(["xcrun", "simctl", "list", "devices", "booted", "-j"])
    if code != 0:
        return None, out.strip()[:200] or "xcrun simctl failed"
    try:
        data = json.loads(out[out.index("{"):])
    except ValueError:
        return None, "simctl answered no JSON"
    sims = []
    for runtime, devices in (data.get("devices") or {}).items():
        for d in devices or []:
            if d.get("state") == "Booted":
                sims.append({"name": d.get("name", ""), "udid": d.get("udid", ""), "runtime": runtime.rsplit(".", 1)[-1]})
    return sims, ""


def adb_devices() -> tuple[Optional[list[dict[str, str]]], str]:
    if not shutil.which("adb"):
        return None, "adb not found (Android platform-tools)"
    code, out = _run(["adb", "devices"])
    if code != 0:
        return None, out.strip()[:200] or "adb devices failed"
    rows = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2:
            rows.append({"serial": parts[0], "state": parts[1]})
    return rows, ""


def chromium_status() -> dict[str, Any]:
    """Whether the web platform can run: Playwright importable and its Chromium downloaded."""
    if importlib.util.find_spec("playwright") is None:
        return {"ok": False, "detail": "playwright not installed (it comes with the [qa] extra); then: playwright install chromium"}
    code = ("from playwright.sync_api import sync_playwright\n"
            "with sync_playwright() as p:\n    print(p.chromium.executable_path)")
    rc, out = _run([sys.executable, "-c", code], timeout=30)
    path = out.strip().splitlines()[-1] if rc == 0 and out.strip() else ""
    if path and pathlib.Path(path).exists():
        return {"ok": True, "detail": f"chromium at {path}"}
    return {"ok": False, "detail": "Chromium is not downloaded: run `playwright install chromium`"
            + (f" ({out.strip()[:160]})" if rc != 0 and out.strip() else "")}


def _extra_status() -> list[dict[str, Any]]:
    out = []
    for mod, dist in EXTRA_MODULES:
        found = importlib.util.find_spec(mod) is not None
        version = None
        if found:
            try:
                from importlib.metadata import version as _v

                version = _v({"PIL": "pillow", "idb": "fb-idb"}.get(mod, mod))
            except Exception:  # noqa: BLE001
                version = None
        out.append({"module": mod, "package": dist, "installed": found, "version": version})
    return out


def _identity_and_portal() -> tuple[Any, Any]:
    from . import config
    from .portal import PortalClient

    ident = config.resolve()
    return ident, PortalClient.from_identity(ident)


# ---------- doctor ----------


def doctor_report(cwd: Optional[pathlib.Path] = None) -> dict[str, Any]:
    """Every check as {name: {ok, detail}} (pure enough to test: shells out, never raises)."""
    cwd = cwd or pathlib.Path.cwd()
    checks: dict[str, dict[str, Any]] = {}

    extra = _extra_status()
    missing = [e["package"] for e in extra if not e["installed"]]
    mcp_ok = next((e for e in extra if e["module"] == "mcp"), {}).get("installed")
    checks["python extra [qa]"] = {
        "ok": not missing,
        "detail": "all installed" if not missing else f"missing: {', '.join(missing)} (uv tool install --force --reinstall --no-cache './orcha-cli[qa]')",
        "modules": extra,
    }
    if mcp_ok:
        ver = next(e for e in extra if e["module"] == "mcp").get("version") or ""
        try:
            major, minor = (int(x) for x in ver.split(".")[:2])
            if (major, minor) < (2, 2):
                checks["python extra [qa]"].update(ok=False, detail=f"mcp {ver} is older than 2.2")
        except ValueError:
            pass

    idb = shutil.which("idb_companion")
    checks["idb_companion"] = {"ok": bool(idb), "detail": idb or "not found (brew install facebook/fb/idb-companion)"}
    code, out = _run(["xcrun", "simctl", "help"]) if shutil.which("xcrun") else (127, "xcrun not found")
    checks["xcrun simctl"] = {"ok": code == 0, "detail": "available" if code == 0 else out.strip()[:200]}
    sims, problem = booted_simulators()
    locks_mod = None
    try:
        from .device import locks as locks_mod  # type: ignore[no-redef]
    except Exception:  # noqa: BLE001
        locks_mod = None

    def lock_of(name: str) -> str:
        if locks_mod is None:
            return ""
        try:
            state = locks_mod.inspect(name)
        except Exception:  # noqa: BLE001
            return ""
        return "" if state is None else f" (locked {int(state.age_s // 60)} min ago{'; stale' if state.stale else ''})"

    if sims is None:
        checks["booted simulators"] = {"ok": False, "detail": problem}
    else:
        checks["booted simulators"] = {
            "ok": bool(sims), "devices": sims,
            "detail": ", ".join(f"{s['name']} ({s['runtime']}){lock_of(s['name'])}" for s in sims) or "none booted (boot iPhone 17 Pro; never create one)",
        }
    checks["playwright + chromium"] = chromium_status()
    adb = shutil.which("adb")
    checks["adb"] = {"ok": bool(adb), "detail": adb or "not found (Android platform-tools; only needed for Android)"}
    devs, problem = adb_devices()
    if devs is None:
        checks["adb devices"] = {"ok": False, "detail": problem}
    else:
        ready = [d for d in devs if d["state"] == "device"]
        checks["adb devices"] = {"ok": bool(ready), "devices": devs,
                                 "detail": ", ".join(f"{d['serial']} ({d['state']})" for d in devs) or "none attached"}

    ident, portal = _identity_and_portal()
    reachable = bool(ident.api_base) and portal.ping()
    detail = f"{ident.api_base or '(no api_base_url)'}: {'reachable' if reachable else 'not reachable'}"
    if reachable and ident.container_id:
        try:
            targets = portal.targets()
            rows = targets if isinstance(targets, list) else (targets or {}).get("targets") or []
            detail += f"; QA routes answer ({len(rows)} target(s))"
        except Exception as e:  # noqa: BLE001
            detail += f"; QA routes: {e}"
            reachable = False
    checks["portal"] = {"ok": reachable, "detail": detail}
    checks["acting agent"] = {"ok": ident.ok, "detail": ident.describe().replace("\n", "; ")}

    try:
        from . import launch

        path = launch.config_path(cwd)
        checks["QA tools for agents"] = {"ok": bool(path), "detail": f"on ({path})" if path else "off (orcha qa enable turns them on)"}
    except Exception as e:  # noqa: BLE001
        checks["QA tools for agents"] = {"ok": False, "detail": f"unknown ({type(e).__name__}: {e})"}
    return checks


#: Checks that only matter for one platform: a failure there is a warning, not an error.
_OPTIONAL = {"adb", "adb devices", "idb_companion", "xcrun simctl", "booted simulators", "QA tools for agents",
             "playwright + chromium"}


def cmd_phone_tools(args: Any) -> int:
    from .device import appium_local

    if appium_local.installed():
        print(f"phone tools are already in {appium_local.tools_dir()}")
        return 0
    print(f"installing Appium {appium_local.APPIUM_VERSION} and XCUITest {appium_local.XCUITEST_VERSION} in {appium_local.tools_dir()}…")
    try:
        appium_local.install()
    except appium_local.AppiumUnavailable as e:
        print(str(e), file=sys.stderr)
        return 1
    print("done")
    return 0


def cmd_doctor(args: Any) -> int:
    checks = doctor_report()
    if getattr(args, "json", False):
        print(json.dumps(checks, indent=2, default=str))
    else:
        for name, c in checks.items():
            mark = "ok  " if c["ok"] else ("warn" if name in _OPTIONAL else "FAIL")
            print(f"[{mark}] {name}: {c['detail']}")
        ios = checks["idb_companion"]["ok"] and checks["booted simulators"]["ok"]
        android = checks["adb devices"]["ok"]
        web = checks["playwright + chromium"]["ok"]
        print(f"platforms ready: ios {'yes' if ios else 'no'}, android {'yes' if android else 'no'}, web {'yes' if web else 'no'}")
    hard = [n for n, c in checks.items() if not c["ok"] and n not in _OPTIONAL]
    return 1 if hard else 0


# ---------- map build ----------


def cmd_map_build(args: Any) -> int:
    repo = pathlib.Path(args.repo or ".").expanduser().resolve()
    if not repo.is_dir():
        print(f"error: {repo} is not a folder", file=sys.stderr)
        return 2
    try:
        from .codemap import build_payload  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        print(f"error: the code map reader is not available in this install ({type(e).__name__}: {e})", file=sys.stderr)
        return 1
    portal = None
    if not args.dry_run:
        ident, portal = _identity_and_portal()
        if not (ident.api_base and ident.container_id):
            print("error: " + "; ".join(ident.problems), file=sys.stderr)
            return 1
        try:
            portal.map_build_start(args.platform)  # the map shows the build while the code is read
        except Exception:  # noqa: BLE001 - an older portal: the import still lands
            pass
    try:
        payload = build_payload(repo, args.platform)
    except Exception as e:  # noqa: BLE001
        print(f"error: reading {repo} failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    try:
        from .codemap import counts

        summary = counts(payload)
    except Exception:  # noqa: BLE001
        summary = {"nodes": len(payload.get("nodes") or []), "edges": len(payload.get("edges") or []),
                   "features": len(payload.get("features") or [])}
    if args.dry_run:
        print(json.dumps(summary, indent=2) if args.json else f"read {repo} ({args.platform}): " + ", ".join(f"{k} {v}" for k, v in summary.items()))
        return 0
    payload.setdefault("platform", args.platform)
    payload.setdefault("source", "code")
    try:
        got = portal.map_import(payload)
    except Exception as e:  # noqa: BLE001
        print(f"error: map import failed: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"read": summary, "imported": got}, indent=2, default=str))
    else:
        print(f"read {repo} ({args.platform}): " + ", ".join(f"{k} {v}" for k, v in summary.items()))
        print(f"imported: {json.dumps(got, default=str) if got is not None else 'ok'}")
    return 0


# ---------- targets ----------


def cmd_targets(args: Any) -> int:
    ident, portal = _identity_and_portal()
    if not (ident.api_base and ident.container_id):
        print("error: " + "; ".join(ident.problems), file=sys.stderr)
        return 1
    setting = any(getattr(args, k, None) for k in ("app_id", "device", "app_name", "build_path", "notes"))
    if setting:
        if not args.platform:
            print("error: --platform is required to set a target", file=sys.stderr)
            return 2
        if args.platform == "web":
            if args.app_id and not args.app_id.startswith(("http://", "https://")):
                print("error: a web target's --app-id is its start URL (http:// or https://)", file=sys.stderr)
                return 2
            if args.device and args.device not in VIEWPORTS:
                print(f"error: a web target's --device is the viewport: {' or '.join(VIEWPORTS)}", file=sys.stderr)
                return 2
        body = {"app_id": args.app_id, "device_name": args.device, "app_name": args.app_name,
                "build_path": args.build_path, "notes": args.notes}
        try:
            got = portal.put_target(args.platform, {k: v for k, v in body.items() if v is not None})
        except Exception as e:  # noqa: BLE001
            print(f"error: {e}", file=sys.stderr)
            return 1
        print(json.dumps(got, indent=2, default=str) if args.json else f"target {args.platform} set")
        return 0
    try:
        got = portal.targets()
    except Exception as e:  # noqa: BLE001
        print(f"error: {e}", file=sys.stderr)
        return 1
    rows = got if isinstance(got, list) else (got or {}).get("targets") or []
    rows = [r for r in rows if not args.platform or r.get("platform") == args.platform]
    if args.json:
        print(json.dumps(rows, indent=2, default=str))
        return 0
    if not rows:
        print("no QA targets set (orcha qa targets --platform ios --app-id <bundle id>)")
    for r in rows:
        print(f"{r.get('platform')}: {r.get('app_id') or '(no app)'}  device: {r.get('device_name') or 'default'}"
              + (f"  name: {r['app_name']}" if r.get("app_name") else "") + (f"  build: {r['build_path']}" if r.get("build_path") else "")
              + (f"\n  notes: {r['notes']}" if r.get("notes") else ""))
    return 0


# ---------- enable / disable ----------


def cmd_request(args: Any) -> int:
    ident, portal = _identity_and_portal()
    if not portal.api_base or not portal.container_id:
        print("error: no portal configured: run this in an Orcha project", file=sys.stderr)
        return 1
    build = {"branch": args.branch, "commit": args.commit, "url": args.url, "app_path": args.app_path, "notes": args.build_notes}
    body = {"kind": args.kind, "platform": args.platform, "finding_ids": args.finding, "scenario_ids": args.scenario, "tags": args.tag, "focus": args.focus,
            "acceptance": args.acceptance, "minutes": args.minutes, "on_fail": args.on_fail,
            "build": {k: v for k, v in build.items() if v} or None}
    try:
        out = portal.create_request({k: v for k, v in body.items() if v not in (None, [])}, args.task)
    except Exception as e:  # noqa: BLE001 - PortalError is one line for the person
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(out, indent=2, default=str))
        return 0
    request = (out or {}).get("request") or {}
    print(f"QA request {request.get('id')}: {request.get('kind')}" + (f" on {request['platform']}" if request.get("platform") else ""))
    print(f"QA task: {(out or {}).get('qa_task_id')}")
    print("The result comes back on the task's thread; a person still verifies the work.")
    return 0


def cmd_enable(args: Any) -> int:
    from . import launch

    root = launch.project_root(pathlib.Path.cwd())
    path = launch.enable(root)
    print(f"QA tools on for {root}: wrote {path}")
    print("New agent runs get the orcha-qa tools; running agents pick them up on their next wake.")
    return 0


def cmd_disable(args: Any) -> int:
    from . import launch

    root = launch.project_root(pathlib.Path.cwd())
    removed = launch.disable(root)
    if removed:
        print(f"QA tools off for {root}: agents launched from now on do not get the orcha-qa tools.")
    else:
        print(f"QA tools were already off for {root}.")
    return 0
