"""Where the QA device tools are: `idb_companion` (iOS simulators) and `adb` (Android).

- `idb_companion_path()`: `ORCHA_IDB_COMPANION` (an override), else the copy the Mac app bundles in
  its runtime (`<runtime>/libexec/idb-companion/idb_companion`, found from the running Python so it
  works wherever the app lives), else the one on PATH (Homebrew's).
- `adb_path()`: the Android SDK that Android Studio installs, `ANDROID_HOME`, then
  `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` (each `<sdk>/platform-tools/adb`), else PATH. The
  app does not ship adb.
- `use_adb()`: put the found adb's folder first on this process's PATH, so every plain `adb` call
  and the adbutils / uiautomator2 libraries use it. QA entry points call it once.

The messages are for a person: `in_app()` picks app-install words over source-checkout commands.
Standard library only.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import sys
from typing import Optional

PLATFORM_TOOLS_URL = "https://developer.android.com/tools/releases/platform-tools"
IDB_COMPANION_ENV = "ORCHA_IDB_COMPANION"
#: Inside the bundled runtime, next to bin/ and lib/.
BUNDLED_IDB_REL = pathlib.Path("libexec") / "idb-companion" / "idb_companion"

ADB_MISSING_APP = ("Embodent can't find adb, the Android tool. Install Android Studio (it includes adb), "
                   f"or Google's platform tools: {PLATFORM_TOOLS_URL}")
ADB_MISSING_SOURCE = ("adb not found: install Android Studio, or Google's platform tools "
                      f"({PLATFORM_TOOLS_URL}), or set ANDROID_HOME to your Android SDK")
IDB_MISSING_APP = "Embodent's iPhone simulator tool (idb_companion) is missing. Reinstall Embodent."
IDB_MISSING_SOURCE = "idb_companion not found: brew tap facebook/fb && brew install facebook/fb/idb-companion"


def in_app() -> bool:
    """True when this runs from the Mac app's bundled runtime (its `bin/orcha` launcher sets it)."""
    return os.environ.get("ORCHA_SIDECAR") == "1"


def _executable(path: pathlib.Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def runtime_root() -> pathlib.Path:
    """The folder of the running Python install: the app's `orcha-runtime` inside the app."""
    return pathlib.Path(sys.prefix)


def bundled_idb_companion() -> Optional[str]:
    path = runtime_root() / BUNDLED_IDB_REL
    return str(path) if _executable(path) else None


def idb_companion_path() -> Optional[str]:
    """The `idb_companion` to start: the override, the bundled copy, then PATH; None when missing."""
    override = os.environ.get(IDB_COMPANION_ENV)
    if override and _executable(pathlib.Path(override).expanduser()):
        return str(pathlib.Path(override).expanduser())
    return bundled_idb_companion() or shutil.which("idb_companion")


def idb_companion_missing() -> str:
    return IDB_MISSING_APP if in_app() else IDB_MISSING_SOURCE


def android_sdk_roots() -> list[pathlib.Path]:
    """The Android SDK folders to look in, in order, each once."""
    roots: list[pathlib.Path] = []
    for raw in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), str(pathlib.Path.home() / "Library/Android/sdk")):
        if raw:
            root = pathlib.Path(raw).expanduser()
            if root not in roots:
                roots.append(root)
    return roots


def adb_path() -> Optional[str]:
    """Android Studio's adb (`<sdk>/platform-tools/adb`), else the one on PATH; None when missing."""
    for root in android_sdk_roots():
        candidate = root / "platform-tools" / "adb"
        if _executable(candidate):
            return str(candidate)
    return shutil.which("adb")


def adb_missing() -> str:
    return ADB_MISSING_APP if in_app() else ADB_MISSING_SOURCE


def use_adb() -> Optional[str]:
    """Put the found adb's folder first on this process's PATH (once); return adb's path or None."""
    found = adb_path()
    if not found:
        return None
    folder = str(pathlib.Path(found).parent)
    parts = os.environ.get("PATH", "").split(os.pathsep) if os.environ.get("PATH") else []
    if not parts or parts[0] != folder:
        os.environ["PATH"] = os.pathsep.join([folder, *[p for p in parts if p != folder]])
    return found
