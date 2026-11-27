"""Can a Quality session run on each platform from this install, and if not, what does a person do?
One row per platform for the Quality tab (`GET .../qa/setup/readiness`), from the same checks as
`orcha qa doctor`:

  {platform, ready, words, link, browser}

`words` is one plain sentence: what is ready, or what is missing and how to get it. `link` is a page
that helps (Google's platform tools for adb). `browser` (web only) is `browser_setup.status()`, so
the tab can offer Download now and show progress. Never raises; every check has a time limit.
"""

from __future__ import annotations

import shutil
from typing import Any, Optional

#: The QA libraries each platform's sessions import.
LIBRARIES = {"ios": ("idb",), "android": ("uiautomator2", "adbutils"), "web": ("playwright",)}
XCODE_WORDS = "Install Xcode from the App Store, then open it once."
NO_AVD_WORDS = "No Android emulator yet: create one in Android Studio's Device Manager."


def _row(platform: str, ready: bool, words: str, link: Optional[str] = None, browser: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {"platform": platform, "ready": ready, "words": words, "link": link, "browser": browser}


def missing_libraries() -> list[str]:
    """The QA packages this install lacks (`mcp` included: the agents' tool server needs it)."""
    from . import cli as qa_cli

    return [e["package"] for e in qa_cli._extra_status() if not e["installed"]]


def _libraries_words(platform: str, installed: dict[str, bool]) -> Optional[str]:
    from . import cli as qa_cli

    from .device import tools

    lacking = [m for m in LIBRARIES[platform] if not installed.get(m)]
    if not lacking:
        return None
    fix = "Update or reinstall Embodent." if tools.in_app() else f"Run: {qa_cli._extra_fix()}"
    return f"The {_name(platform)} test tools are missing from this install. {fix}"


def _name(platform: str) -> str:
    return {"ios": "iPhone simulator", "android": "Android", "web": "website"}[platform]


def ios() -> dict[str, Any]:
    from . import cli as qa_cli
    from .device import tools

    installed = {e["module"]: e["installed"] for e in qa_cli._extra_status()}
    if words := _libraries_words("ios", installed):
        return _row("ios", False, words)
    if not tools.idb_companion_path():
        return _row("ios", False, tools.idb_companion_missing())
    if not shutil.which("xcrun"):
        return _row("ios", False, XCODE_WORDS)
    sims, problem = qa_cli.booted_simulators()
    if sims is None:
        return _row("ios", False, f"Xcode's simulator tools don't answer ({problem}). {XCODE_WORDS}")
    if sims:
        names = ", ".join(s["name"] for s in sims[:3])
        return _row("ios", True, f"Ready: {names} running.")
    return _row("ios", True, "Ready. No simulator is running: one starts when a run starts.")


def android() -> dict[str, Any]:
    from . import cli as qa_cli
    from .device import tools

    installed = {e["module"]: e["installed"] for e in qa_cli._extra_status()}
    if words := _libraries_words("android", installed):
        return _row("android", False, words)
    if not tools.adb_path():
        return _row("android", False, tools.adb_missing(), tools.PLATFORM_TOOLS_URL)
    devs, problem = qa_cli.adb_devices()
    if devs is None:
        return _row("android", False, f"adb doesn't answer ({problem}). Open Android Studio once, then try again.")
    ready = [d["serial"] for d in devs if d["state"] == "device"]
    if ready:
        return _row("android", True, f"Ready: {', '.join(ready[:3])} attached.")
    try:
        from .device import android_u2

        avds = android_u2.avd_names()
    except Exception:  # noqa: BLE001 - an unreadable SDK reads as no emulator
        avds = []
    if avds:
        return _row("android", True, "Ready. No emulator is running: one starts when a run starts.")
    return _row("android", False, NO_AVD_WORDS)


def web() -> dict[str, Any]:
    from . import browser_setup
    from . import cli as qa_cli

    installed = {e["module"]: e["installed"] for e in qa_cli._extra_status()}
    if words := _libraries_words("web", installed):
        return _row("web", False, words)
    st = browser_setup.status()
    if st["installed"]:
        return _row("web", True, "Ready: the test browser is downloaded.", browser=st)
    if st["state"] == "downloading":
        done = f", {st['percent']}% done" if st.get("percent") is not None else ""
        return _row("web", False, f"Downloading the test browser ({browser_setup.SIZE_WORDS}, one time){done}.", browser=st)
    if st["state"] == "failed":
        return _row("web", False, f"The test browser download failed: {st.get('error')}", browser=st)
    return _row("web", False, f"The test browser ({browser_setup.SIZE_WORDS}) downloads the first time you test a website.",
                browser=st)


def platforms() -> list[dict[str, Any]]:
    rows = []
    for name, check in (("ios", ios), ("android", android), ("web", web)):
        try:
            rows.append(check())
        except Exception as e:  # noqa: BLE001 - one broken check never hides the others
            rows.append(_row(name, False, f"Embodent couldn't check this: {type(e).__name__}: {e}"))
    return rows
