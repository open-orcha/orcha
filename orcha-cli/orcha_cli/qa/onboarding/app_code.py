"""Which files are the app's own code (adapted from `auth/detect.py`): a test, fixture, mock,
doc or developer script may name a backend, but the app does not ship it."""

from __future__ import annotations

import os
import re

_TEST_PATH = re.compile(
    r"(^|/)(?i:tests?|__tests__|e2e|spec|specs|fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-data|docs?|examples?|stories)(/|$)"
    r"|[A-Za-z0-9]Tests?/|\.(test|spec|stories)\.[A-Za-z]+$|(^|/)test_[^/]+\.py$|_test\.(py|go|dart)$|Tests?\.(swift|kt|java)$",
)


#: Folders of UI tests an app's repository keeps beside it, which `_TEST_PATH` does not name.
_UI_TEST_DIR = re.compile(r"(^|/)(?:maestro|\.maestro|detox|cypress|playwright|integration_test|androidTest)(/|$)", re.I)
#: Developer tooling: scripts run by hand or in CI (often against a local stack), release lanes.
#: Never shipped in the app, so never its sign-in or its backend (#468).
TOOLING_DIRS = frozenset({
    "scripts", "script", "tools", "tool", "tooling", "devtools", "bin", "ci", ".github", ".circleci", ".husky", "fastlane",
})
#: Folders where an app keeps its own code. A tooling-named folder inside one (`src/scripts/`) is
#: the app's code, not tooling.
SOURCE_DIRS = frozenset({
    "src", "source", "sources", "app", "lib", "pages", "components", "screens", "views", "features", "modules",
})


def is_test_path(rel: str) -> bool:
    """A test, fixture, mock, story or doc: it mentions sign-in, it does not offer it."""
    return bool(_TEST_PATH.search(rel.replace(os.sep, "/")))


def is_tooling_path(rel: str) -> bool:
    """A file in a developer tooling folder (`scripts/verify.ts`, `apps/mobile/scripts/seed.ts`,
    `tools/`, `bin/`, CI), unless that folder sits inside the app's source (`src/scripts/`)."""
    for part in rel.replace(os.sep, "/").lower().split("/")[:-1]:
        if part in SOURCE_DIRS:
            return False
        if part in TOOLING_DIRS:
            return True
    return False


def not_app_code(rel: str) -> bool:
    """Not the app's own code: a test, fixture, mock, doc, UI test or developer tooling. It may
    sign in or name a backend, but the app does not ship it, so it is never evidence."""
    rel = rel.replace(os.sep, "/")
    return is_test_path(rel) or is_tooling_path(rel) or bool(_UI_TEST_DIR.search(rel))
