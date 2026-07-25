"""Read canonical portal source bundles for source-contract tests.

Production portal code is split into responsibility-based assets. These helpers
let static and JavaScript harness tests inspect the same ordered source that a
browser loads without coupling assertions to the former monolithic files.
"""

from __future__ import annotations

import re
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"

_SCRIPT_MODULES = {
    "app.js": [
        "modules/app-state.js",
        "modules/app-text.js",
        "modules/app-data.js",
        "modules/app-ui.js",
        "modules/app-shell.js",
        "modules/app-autonomy.js",
        "modules/app-notifications.js",
        "modules/app-pairing.js",
        "modules/app-patch-log.js",
        "modules/app-run-classify.js",
        "modules/app-run-stream.js",
        "modules/app-sort.js",
    ],
    "conversation.js": [
        "modules/conversation-state.js",
        "modules/conversation-terminal-open.js",
        "modules/conversation-terminal-state.js",
        "modules/conversation-render.js",
        "modules/conversation-composer.js",
        "modules/conversation-lifecycle.js",
    ],
    "onboarding.js": [
        "modules/onboarding-state.js",
        "modules/onboarding-shell.js",
        "modules/onboarding-tasks.js",
        "modules/onboarding-roster.js",
        "modules/onboarding-agent-create.js",
        "modules/onboarding-agent-created.js",
        "modules/onboarding-proposal-model.js",
        "modules/onboarding-proposal-flow.js",
        "modules/onboarding-welcome-fork.js",
        "modules/onboarding-boot.js",
    ],
    "settings.js": [
        "modules/settings-key-state.js",
        "modules/settings-key-panel.js",
        "modules/settings-models.js",
        "modules/settings-provider-keys.js",
        "modules/settings-appearance.js",
    ],
}


def script_source(name: str) -> str:
    """Return a script plus its responsibility modules in browser load order."""
    paths = [*_SCRIPT_MODULES.get(name, []), name]
    return "\n".join((STATIC / path).read_text() for path in paths)


def style_source(name: str = "styles.css") -> str:
    """Return a stylesheet plus the split styles it coordinates."""
    if name != "styles.css":
        return (STATIC / name).read_text()
    paths = [
        "styles/tokens.css",
        "styles/shell.css",
        "styles/components.css",
        "styles/overlays.css",
        "styles/conversation.css",
        "styles/responsive.css",
        "styles.css",
    ]
    return "\n".join((STATIC / path).read_text() for path in paths)


def page_source(name: str) -> str:
    """Return page markup and its page-owned assets in browser load order.

    Shared app/data modules are deliberately omitted: page contract tests should
    not accidentally match an unrelated shared implementation.
    """
    html = (STATIC / name).read_text()
    refs = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
    parts = [html]
    for ref in refs:
        relative = ref.removeprefix("/assets/")
        if relative in {"app.js", "data.js"}:
            continue
        if relative.startswith("modules/app-") or relative.startswith("vendor/"):
            continue
        path = STATIC / relative
        if path.is_file():
            parts.append(path.read_text(errors="replace"))
    return "\n".join(parts)
