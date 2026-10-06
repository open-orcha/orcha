"""`orcha doctor [--json]` — one screen a non-engineer can paste into a bug report
(GH #258 plan R4, PR 10).

It reports the project's runtime, its ports (is anything listening, does the portal
answer), the background service, whether ``claude``/``codex``/``git``/``gh`` are found on
the PATH the service runs with, the SQLite version (3.38 or newer is required), free disk,
and the last 20 lines of each log. Problems are listed in plain English at the end. It
reads only — nothing is started, stopped or written — and works outside a project too
(then only the machine checks run). ``--json`` prints the same report as one JSON object
for the Mac app. The exit code is 0 whenever the report was produced; read ``ok``.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import platform
import shutil
import sqlite3
import sys
from typing import Optional

from orcha_cli import cli_logs, cli_runtime_mode, cli_serve, cli_serve_support, cli_service

TOOLS = ("claude", "codex", "git", "gh")
LOGS = cli_logs.CHILDREN + ("launchd",)
LOG_LINES = 20
MIN_SQLITE = (3, 38, 0)
MIN_FREE_BYTES = 1 << 30  # 1 GiB


def _version_tuple(text: str) -> tuple:
    return tuple(int(p) for p in text.split(".")[:3] if p.isdigit())


def _cli_version() -> str:
    try:
        from importlib.metadata import version
        return version("orcha-cli")
    except Exception:
        return "0.0.0+source"


def _tools(path_env: str) -> dict:
    return {tool: shutil.which(tool, path=path_env) for tool in TOOLS}


def _port(port, *, http_url: Optional[str] = None) -> dict:
    if not port:
        return {"port": None, "listening": False}
    out = {"port": int(port), "listening": cli_serve_support.tcp_open(int(port))}
    if http_url is not None:
        out["answers"] = cli_serve_support.http_ok(http_url)
    return out


def collect(root: pathlib.Path) -> dict:
    root = pathlib.Path(root).resolve()
    cfg = cli_runtime_mode.read_config(root)
    project = cli_runtime_mode.is_project(root, cfg)
    try:
        runtime = cli_runtime_mode.detect_runtime(root, cfg) if project else None
    except ValueError:
        runtime = None
    native = runtime == cli_runtime_mode.NATIVE
    report: dict = {
        "project_dir": str(root), "is_project": project, "runtime": runtime,
        "project_name": cfg.get("project_name") if project else None,
        "cli_version": _cli_version(), "python": sys.executable,
        "python_version": platform.python_version(),
        "os": f"macOS {platform.mac_ver()[0]}" if sys.platform == "darwin" else platform.platform(),
    }
    problems: list = []

    service = cli_service.status(root) if native else None
    report["service"] = service
    path_env = (service or {}).get("path_env")
    report["path_source"] = "service" if path_env else "this shell"
    report["path_env"] = path_env or os.environ.get("PATH", "")
    report["tools"] = _tools(report["path_env"])
    if not report["tools"]["git"]:
        problems.append("git was not found; install the Xcode command line tools "
                        "(`xcode-select --install`) or Homebrew git")
    if not (report["tools"]["claude"] or report["tools"]["codex"]):
        problems.append("neither the claude nor the codex command was found, so agents cannot "
                        "run; install Claude Code or Codex")

    sqlite_ok = _version_tuple(sqlite3.sqlite_version) >= MIN_SQLITE
    report["sqlite"] = {"version": sqlite3.sqlite_version, "ok": sqlite_ok}
    if not sqlite_ok:
        problems.append(f"SQLite {sqlite3.sqlite_version} is too old (3.38 or newer is needed)")

    usage = shutil.disk_usage(root if root.exists() else pathlib.Path.home())
    report["disk"] = {"free_bytes": usage.free, "total_bytes": usage.total,
                      "ok": usage.free >= MIN_FREE_BYTES}
    if usage.free < MIN_FREE_BYTES:
        problems.append(f"less than 1 GB of disk is free ({usage.free // 2**20} MB)")

    if not project:
        problems.append(f"{root} is not an Orcha project (run `orcha init` there, or pass "
                        "--project-dir)")
    else:
        api_port = cfg.get("api_port")
        report["ports"] = {
            "api": _port(api_port, http_url=f"http://127.0.0.1:{api_port}/" if api_port else None),
            "bridge": _port(cfg.get("bridge_port")),
        }
        if not report["ports"]["api"].get("answers"):
            problems.append("the portal is not answering; start Orcha with `orcha up`")
    if native:
        pid = cli_serve.serve_running(root)
        state = cli_serve_support.read_state(root) if pid else {}
        report["serve"] = {"pid": pid, "children": state.get("children") or {}}
        db = cli_runtime_mode.db_path(root, cfg)
        report["database"] = {"path": str(db), "exists": db.exists(),
                              "size_bytes": db.stat().st_size if db.exists() else None}
        if service and service["supported"] and not service["installed"]:
            problems.append("the background service is not installed, so Orcha will not "
                            "start after a reboot; run `orcha service install`")
        report["logs"] = {name: [line.rstrip("\n") for line in
                                 cli_logs.tail_lines(cli_serve_support.log_path(root, name), LOG_LINES)]
                          for name in LOGS if cli_serve_support.log_path(root, name).exists()}
    elif runtime == cli_runtime_mode.DOCKER:
        report["logs_hint"] = f"docker compose -f {cli_runtime_mode.compose_path(root)} logs --tail 20"
    report["problems"] = problems
    report["ok"] = not problems
    return report


def _yn(flag) -> str:
    return "yes" if flag else "no"


def render(report: dict) -> str:
    lines = [f"Orcha doctor — {report['project_dir']}",
             f"  orcha:       {report['cli_version']} (python {report['python_version']}, {report['os']})",
             f"  runtime:     {report['runtime'] or 'no project here'}"]
    for name, info in (report.get("ports") or {}).items():
        extra = f", answers {_yn(info['answers'])}" if "answers" in info else ""
        lines.append(f"  {name + ' port:':<13}{info['port'] or '-'} (listening {_yn(info['listening'])}{extra})")
    svc = report.get("service")
    if svc is not None:
        if not svc["supported"]:
            lines.append("  service:     not available on this OS")
        elif not svc["installed"]:
            lines.append("  service:     not installed")
        else:
            pid = f", pid {svc['pid']}" if svc.get("pid") else ""
            lines.append(f"  service:     {svc.get('state') or ('not loaded' if not svc['loaded'] else '?')}{pid} ({svc['label']})")
    if report.get("serve") is not None:
        lines.append(f"  serve:       {'pid ' + str(report['serve']['pid']) if report['serve']['pid'] else 'stopped'}")
        for child, info in report["serve"]["children"].items():
            lines.append(f"    {child:<9}{info.get('status', '?')} (restarts {info.get('restarts', 0)})")
    if report.get("database"):
        db = report["database"]
        size = f"{db['size_bytes'] / 2**20:.1f} MB" if db["exists"] else "missing"
        lines.append(f"  database:    {db['path']} ({size})")
    lines.append(f"  tools (PATH from {report['path_source']}):")
    for tool, where in report["tools"].items():
        lines.append(f"    {tool:<9}{where or 'NOT FOUND'}")
    lines.append(f"  sqlite:      {report['sqlite']['version']}{'' if report['sqlite']['ok'] else ' (too old)'}")
    lines.append(f"  disk free:   {report['disk']['free_bytes'] / 2**30:.1f} GB")
    for name, tail in (report.get("logs") or {}).items():
        lines.append(f"  --- {name}.log (last {len(tail)} lines) ---")
        lines.extend(f"    {line}" for line in tail)
    if report.get("logs_hint"):
        lines.append(f"  logs:        {report['logs_hint']}")
    if report["problems"]:
        lines.append("Problems:")
        lines.extend(f"  - {p}" for p in report["problems"])
    else:
        lines.append("No problems found.")
    return "\n".join(lines)


def cmd_doctor(args: argparse.Namespace) -> None:
    report = collect(pathlib.Path(args.project_dir or pathlib.Path.cwd()))
    print(json.dumps(report) if args.json else render(report), flush=True)
