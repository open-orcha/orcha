"""`orcha pair --lan | --local`: whether phones on this network can reach a native portal.

A native portal binds 127.0.0.1 unless orcha.json says ``"bind": "lan"`` (plan R-D3);
Docker published it on every interface, which is what phone pairing relied on. This
flips the setting and restarts only the portal: `orcha serve` rebuilds the portal's
argv from orcha.json on every start, so ending the portal child is the whole rebind.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import signal
import sys

from .cli_runtime_mode import NATIVE, config_path, detect_runtime, read_config
from .cli_serve import serve_running
from .cli_serve_support import read_state


def _write_bind(root: pathlib.Path, cfg: dict, bind: str) -> None:
    cfg = {**cfg, "bind": bind}
    path = config_path(root)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp, path)


def _restart_portal(root: pathlib.Path) -> bool:
    """End the supervised portal child so `orcha serve` starts it on the new bind."""
    if not serve_running(root):
        return False
    pid = (read_state(root).get("children") or {}).get("portal", {}).get("pid")
    if not isinstance(pid, int):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def cmd_pair(args: argparse.Namespace) -> None:
    root = pathlib.Path(args.project_dir or pathlib.Path.cwd()).resolve()
    if not config_path(root).exists():
        sys.exit(f"error: no Orcha project in {root} — run `orcha init` first.")
    cfg = read_config(root)
    current = "lan" if cfg.get("bind") == "lan" else "loopback"
    if detect_runtime(root, cfg) != NATIVE:
        print("[orcha] this project runs on Docker, which already accepts phones on your network.")
        return
    if args.lan:
        wanted = "lan"
    elif args.local:
        wanted = "loopback"
    else:
        print(f"[orcha] phone access: {'on (this network)' if current == 'lan' else 'off (this computer only)'}")
        return
    if wanted == current:
        print(f"[orcha] phone access is already {'on' if wanted == 'lan' else 'off'}.")
        return
    _write_bind(root, cfg, wanted)
    restarted = _restart_portal(root)
    state = "on: phones on this network can reach the portal" if wanted == "lan" \
        else "off: only this computer can reach the portal"
    print(f"[orcha] phone access {state}.")
    if restarted:
        print("[orcha] the portal is restarting on the new address.")
    else:
        print("[orcha] run `orcha up` to apply it.")
    if wanted == "lan":
        print("[orcha] if macOS asks whether Python may accept incoming connections, choose Allow.")
