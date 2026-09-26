"""FAST project-kind signal detection for the new-project roster suggester
(local-run onboarding). Pure, DB-free, filesystem-only logic — kept separate from
`roster_suggest_routes.py` so the scan/mapping heuristics can be unit-tested without
spinning up the FastAPI app or a database.

WHY os.scandir, not git: `local_git.py` operates on COMMITTED state only (see its
docstring), but a brand-new project provisioned moments ago may have zero commits —
`git ls-tree` would return nothing and the roster suggester would come back empty for
the exact moment it matters most (right after `orcha up` on a fresh folder). So this
module walks the WORKING TREE directly at ORCHA_LOCAL_REPO_DIR, the same read-only
mount `local_git.available()` checks for, via `os.scandir` — cheap, no subprocess, no
git-repo requirement.

WHY bounded (depth/entries/time), not a full walk: this endpoint's whole purpose is a
sub-500ms response with NO LLM call, so a large monorepo or a node_modules-not-yet-
ignored tree must never turn a "suggest a roster" click into a multi-second stall. The
walk stops early — on depth, on entry count, or on a wall-clock budget — and reports
honestly on whatever signals it found in time; it never raises for "ran out of budget".

WHY filename/dirname signals + a capped peek at two manifests, not broad file reads:
detecting "this is a React + FastAPI + Docker project" doesn't need file contents for
most stacks — the presence of package.json, tsconfig.json, go.mod, Cargo.toml, a
Dockerfile, a migrations/ dir, etc. is enough. The two exceptions (package.json,
pyproject.toml) get a capped 4KB read so we can tell "React" from "Vue" from "plain
Node" and "FastAPI" from "Django" from "Flask" — still just a substring peek, not a
parse, so a malformed manifest never raises.
"""

import os
import time

# ---------- scan bounds (all soft — a bound running out degrades the result, ----------
# ---------- it never raises) ----------

MAX_DEPTH = 3
MAX_ENTRIES = 400
TIME_BUDGET_SECONDS = 0.2  # 200ms soft budget for the whole walk

# Directories we never descend into: build output / dependency caches / VCS internals.
# Matched by exact basename (cheap, no globbing) — same spirit as .gitignore defaults.
_SKIP_DIRNAMES = {
    "node_modules", ".git", "dist", "build", ".venv", "venv", "vendor", "Pods",
    "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".next", ".nuxt",
    "target", "bin", "obj",
}

# A capped peek at these two manifests only — enough to name a frontend/backend
# framework without reading arbitrary project source.
_MANIFEST_PEEK_BYTES = 4096
_PEEK_FILENAMES = {"package.json", "pyproject.toml"}


def _should_skip_dir(name: str) -> bool:
    if name.startswith("."):
        return True
    return name in _SKIP_DIRNAMES


def _peek(path: str) -> str:
    """Best-effort capped text read for the two manifest files. Empty string on any
    failure (missing, permission, huge/binary, bad encoding) — a peek is an
    enrichment, never a requirement."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read(_MANIFEST_PEEK_BYTES)
        return raw.decode("utf-8", errors="ignore")
    except OSError:
        return ""


def scan_workspace(root: str) -> dict:
    """Bounded os.scandir walk of `root` (the working tree, NOT git state).

    Returns {"entries": [{"name","is_dir","depth","rel_path"}], "truncated": bool,
    "peeked": {"package.json": str, "pyproject.toml": str}} — `truncated` is honest
    telemetry (not currently surfaced in the API response) for why a scan may look
    thin: it hit MAX_ENTRIES or TIME_BUDGET_SECONDS before finishing, distinct from a
    genuinely small project. Never raises: an unreadable root yields an empty result.
    """
    entries: list[dict] = []
    peeked: dict[str, str] = {}
    truncated = False
    deadline = time.monotonic() + TIME_BUDGET_SECONDS

    # Explicit stack-based walk (not os.walk) so depth and the time/entry budgets can
    # be checked between every single directory listing, not just between top-level
    # iterations — a single huge directory must not blow the budget before the first
    # check.
    stack = [(root, 0, "")]
    while stack:
        if time.monotonic() >= deadline:
            truncated = True
            break
        if len(entries) >= MAX_ENTRIES:
            truncated = True
            break
        current_dir, depth, rel_prefix = stack.pop()
        try:
            with os.scandir(current_dir) as it:
                children = list(it)
        except OSError:
            continue
        for child in children:
            if time.monotonic() >= deadline:
                truncated = True
                break
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
            try:
                is_dir = child.is_dir(follow_symlinks=False)
            except OSError:
                continue
            rel_path = f"{rel_prefix}{child.name}"
            entries.append(
                {"name": child.name, "is_dir": is_dir, "depth": depth, "rel_path": rel_path}
            )
            if child.name in _PEEK_FILENAMES and not is_dir and depth == 0:
                peeked[child.name] = _peek(child.path)
            if is_dir and depth + 1 <= MAX_DEPTH and not _should_skip_dir(child.name):
                stack.append((child.path, depth + 1, f"{rel_path}/"))

    return {"entries": entries, "truncated": truncated, "peeked": peeked}


# ---------- signal detection ----------

# Each signal: (signal_id, human-readable description used in a rationale string).
# Detection below fills `signals: set[str]` with the ids that fired.


def detect_signals(scan: dict) -> "tuple[set, dict]":
    """Turn a scan_workspace() result into (signal_ids, evidence). `evidence` maps
    each fired signal id to the concrete rel_path(s)/manifest hit that triggered it,
    so a rationale string can cite something real ("found ios/ + Package.swift")
    instead of a generic template."""
    names_at_root = {e["name"] for e in scan["entries"] if e["depth"] == 0}
    dirnames = {e["name"] for e in scan["entries"] if e["is_dir"]}
    all_names = [e["name"] for e in scan["entries"]]
    rel_by_name: dict[str, list[str]] = {}
    for e in scan["entries"]:
        rel_by_name.setdefault(e["name"], []).append(e["rel_path"])

    signals: set = set()
    evidence: dict = {}

    def fire(signal_id: str, *paths: str):
        signals.add(signal_id)
        evidence.setdefault(signal_id, [])
        for p in paths:
            if p not in evidence[signal_id]:
                evidence[signal_id].append(p)

    package_json = scan["peeked"].get("package.json", "")
    pyproject = scan["peeked"].get("pyproject.toml", "")

    # --- JS/TS / frontend ---
    if "package.json" in names_at_root:
        fire("package_json", "package.json")
        if '"react"' in package_json or '"next"' in package_json:
            fire("react", "package.json (react/next dep)")
        if '"vue"' in package_json:
            fire("vue", "package.json (vue dep)")
        if '"electron"' in package_json:
            fire("electron", "package.json (electron dep)")
    if "tsconfig.json" in names_at_root:
        fire("tsconfig", "tsconfig.json")

    # --- Python / backend ---
    if "pyproject.toml" in names_at_root:
        fire("pyproject", "pyproject.toml")
    if "requirements.txt" in names_at_root:
        fire("requirements", "requirements.txt")
    if "fastapi" in pyproject.lower():
        fire("fastapi", "pyproject.toml (fastapi dep)")
    if "django" in pyproject.lower():
        fire("django", "pyproject.toml (django dep)")
    if "flask" in pyproject.lower():
        fire("flask", "pyproject.toml (flask dep)")

    # --- other backend languages ---
    if "go.mod" in names_at_root:
        fire("go", "go.mod")
    if "Cargo.toml" in names_at_root:
        fire("rust", "Cargo.toml")

    # --- iOS / Swift ---
    xcodeproj_hits = [n for n in all_names if n.endswith(".xcodeproj")]
    if xcodeproj_hits:
        fire("xcodeproj", *rel_by_name.get(xcodeproj_hits[0], [xcodeproj_hits[0]]))
    if "Package.swift" in names_at_root:
        fire("swift_package", "Package.swift")
    if "ios" in dirnames:
        fire("ios_dir", "ios/")

    # --- Android ---
    if "android" in dirnames:
        fire("android_dir", "android/")
    gradle_hits = [n for n in all_names if n.startswith("build.gradle")]
    if gradle_hits:
        fire("gradle", *rel_by_name.get(gradle_hits[0], [gradle_hits[0]]))

    # --- infra ---
    if "Dockerfile" in names_at_root:
        fire("dockerfile", "Dockerfile")
    compose_hits = [n for n in all_names if "docker-compose" in n]
    if compose_hits:
        fire("docker_compose", *rel_by_name.get(compose_hits[0], [compose_hits[0]]))
    if "k8s" in dirnames:
        fire("k8s_dir", "k8s/")
    tf_hits = [n for n in all_names if n.endswith(".tf")]
    if tf_hits or "terraform" in dirnames:
        fire("terraform", *(rel_by_name.get(tf_hits[0], [tf_hits[0]]) if tf_hits else ["terraform/"]))
    if ".github" in dirnames:
        workflow_names = [e["rel_path"] for e in scan["entries"] if e["rel_path"].startswith(".github/workflows")]
        fire("github_actions", *(workflow_names or [".github/"]))

    # --- data / migrations ---
    if "migrations" in dirnames:
        fire("migrations_dir", "migrations/")
    sql_hits = [n for n in all_names if n.endswith(".sql")]
    if sql_hits:
        fire("sql_files", *rel_by_name.get(sql_hits[0], [sql_hits[0]]))
    prisma_hits = [n for n in all_names if n == "schema.prisma" or n.endswith(".prisma")]
    if prisma_hits:
        fire("prisma", *rel_by_name.get(prisma_hits[0], [prisma_hits[0]]))

    # --- docs ---
    docs_files = [e for e in scan["entries"] if e["rel_path"].startswith("docs/") and not e["is_dir"]]
    if "docs" in dirnames and len(docs_files) > 2:
        fire("docs_heavy", f"docs/ ({len(docs_files)} files)")
    if "README.md" in names_at_root or "README" in names_at_root:
        fire("readme", "README.md")

    # --- extension-tally fallback (manifest-less trees) ---
    # A bare source tree (no package.json/pyproject at root — think a repo subdir, a
    # fresh extraction, or a monorepo piece) still deserves specialists. Count source
    # extensions across the scan and fire the language signals the manifests would
    # have; manifest evidence stays preferred, so these only ADD where nothing fired.
    ext_counts: dict[str, int] = {}
    for e in scan["entries"]:
        if e["is_dir"]:
            continue
        name = e["name"]
        dot = name.rfind(".")
        if dot > 0:
            ext = name[dot:].lower()
            ext_counts[ext] = ext_counts.get(ext, 0) + 1

    def _tally(exts: "tuple[str, ...]") -> int:
        return sum(ext_counts.get(x, 0) for x in exts)

    ts_n = _tally((".ts", ".tsx", ".jsx"))
    py_n = _tally((".py",))
    swift_n = _tally((".swift",))
    kt_n = _tally((".kt", ".kts"))
    go_n = _tally((".go",))
    rs_n = _tally((".rs",))
    if ts_n >= 5 and not (signals & {"react", "vue", "tsconfig", "package_json"}):
        fire("ts_sources", f"{ts_n} .ts/.tsx files")
    if py_n >= 5 and not (signals & {"pyproject", "requirements", "fastapi", "django", "flask"}):
        fire("py_sources", f"{py_n} .py files")
    if swift_n >= 3 and not (signals & {"xcodeproj", "swift_package", "ios_dir"}):
        fire("swift_sources", f"{swift_n} .swift files")
    if kt_n >= 3 and not (signals & {"android_dir", "gradle"}):
        fire("kotlin_sources", f"{kt_n} .kt files")
    if go_n >= 5 and "go" not in signals:
        fire("go", f"{go_n} .go files")
    if rs_n >= 5 and "rust" not in signals:
        fire("rust", f"{rs_n} .rs files")

    # --- tests ---
    if "tests" in dirnames:
        fire("tests_dir", "tests/")
    if "__tests__" in dirnames:
        fire("tests_dir", "__tests__/")
    go_test_hits = [n for n in all_names if n.endswith("_test.go")]
    if go_test_hits:
        fire("tests_dir", *rel_by_name.get(go_test_hits[0], [go_test_hits[0]]))

    return signals, evidence


# ---------- roster mapping ----------

ATLAS = {
    "alias": "atlas",
    "role": "Lead orchestrator",
    "focus": "Coordinates the fleet, owns priorities and reviews",
    "kind": "ai",
    "is_main": True,
}

MAX_SPECIALISTS = 4


def _specialist(alias, role, focus, rationale):
    return {
        "alias": alias,
        "role": role,
        "focus": focus,
        "kind": "ai",
        "is_main": False,
        "rationale": rationale,
    }


def _cite(evidence: dict, *signal_ids: str) -> str:
    """Build a short 'found X + Y' rationale citing the concrete evidence paths for
    whichever of the given signal ids actually fired (in priority order). A bare
    manifest name (e.g. "package.json") is skipped once a more specific citation for
    the SAME file already appeared (e.g. "package.json (react/next dep)") — avoids a
    redundant "found package.json (react dep) + package.json" rationale."""
    cited: list[str] = []
    bare_files_seen: set = set()
    for sid in signal_ids:
        for path in evidence.get(sid, []):
            bare_name = path.split(" (", 1)[0]
            if "(" in path:
                bare_files_seen.add(bare_name)
            elif path in bare_files_seen:
                continue  # a more specific citation for this file already fired
            if path not in cited:
                cited.append(path)
    if not cited:
        return "detected from the project layout"
    return "found " + " + ".join(cited[:3])


def build_roster(signals: set, evidence: dict) -> "tuple[str, list]":
    """Map detected signals -> (project_kind, suggestions). ALWAYS leads with atlas
    (the lead orchestrator convention); then up to MAX_SPECIALISTS specialists, one
    per major area, ordered by how central that area looks in a typical project
    (frontend/backend first, then infra/data/docs/tests) so the most load-bearing
    specialists survive the cap on a signal-rich repo."""
    suggestions = [dict(ATLAS, rationale="always leads the fleet")]
    kinds: list[str] = []

    frontend = signals & {"react", "vue", "tsconfig", "electron", "package_json", "ts_sources"}
    backend = signals & {"fastapi", "django", "flask", "go", "rust", "pyproject", "requirements", "py_sources"}
    ios = signals & {"xcodeproj", "swift_package", "ios_dir", "swift_sources"}
    android = signals & {"android_dir", "gradle", "kotlin_sources"}
    infra = signals & {"dockerfile", "docker_compose", "k8s_dir", "terraform", "github_actions"}
    data = signals & {"migrations_dir", "sql_files", "prisma"}
    docs = signals & {"docs_heavy"}
    tests = signals & {"tests_dir"}

    if frontend & {"react", "vue", "electron", "ts_sources"} or (frontend and "package_json" in frontend):
        label = "React" if "react" in signals else ("Vue" if "vue" in signals else "frontend")
        suggestions.append(
            _specialist(
                "nova", "Frontend engineer",
                f"Builds and maintains the {label} UI",
                _cite(evidence, "react", "vue", "electron", "tsconfig", "package_json", "ts_sources"),
            )
        )
        kinds.append("frontend")

    if backend:
        label = (
            "FastAPI" if "fastapi" in signals else
            "Django" if "django" in signals else
            "Flask" if "flask" in signals else
            "Go" if "go" in signals else
            "Rust" if "rust" in signals else "backend"
        )
        suggestions.append(
            _specialist(
                "forge", "Backend engineer",
                f"Owns the {label} service and its API surface",
                _cite(evidence, "fastapi", "django", "flask", "go", "rust", "pyproject", "requirements", "py_sources"),
            )
        )
        kinds.append("backend")

    if len(suggestions) - 1 < MAX_SPECIALISTS and ios:
        suggestions.append(
            _specialist(
                "swift", "iOS engineer",
                "Builds and maintains the iOS/Swift app",
                _cite(evidence, "xcodeproj", "swift_package", "ios_dir", "swift_sources"),
            )
        )
        kinds.append("ios")

    if len(suggestions) - 1 < MAX_SPECIALISTS and android:
        suggestions.append(
            _specialist(
                "droid", "Android engineer",
                "Builds and maintains the Android/Kotlin app",
                _cite(evidence, "android_dir", "gradle", "kotlin_sources"),
            )
        )
        kinds.append("android")

    if len(suggestions) - 1 < MAX_SPECIALISTS and infra:
        suggestions.append(
            _specialist(
                "rig", "Infra & CI",
                "Owns Docker/CI/deploy pipelines",
                _cite(evidence, "dockerfile", "docker_compose", "k8s_dir", "terraform", "github_actions"),
            )
        )
        kinds.append("infra")

    if len(suggestions) - 1 < MAX_SPECIALISTS and data:
        suggestions.append(
            _specialist(
                "keeper", "Data & migrations",
                "Owns schema migrations and data integrity",
                _cite(evidence, "migrations_dir", "sql_files", "prisma"),
            )
        )
        kinds.append("data")

    if len(suggestions) - 1 < MAX_SPECIALISTS and docs:
        suggestions.append(
            _specialist(
                "scribe", "Docs & knowledge",
                "Keeps docs and project knowledge current",
                _cite(evidence, "docs_heavy"),
            )
        )
        kinds.append("docs")

    if len(suggestions) - 1 < MAX_SPECIALISTS and tests:
        suggestions.append(
            _specialist(
                "probe", "QA & regressions",
                "Owns test coverage and catches regressions",
                _cite(evidence, "tests_dir"),
            )
        )
        kinds.append("tests")

    # Cap total at 5 (1 main + max 4 specialists) — trim lowest-priority extras.
    suggestions = suggestions[: 1 + MAX_SPECIALISTS]
    kinds = kinds[:MAX_SPECIALISTS]

    if ios and not android and "react" not in signals and "vue" not in signals and not backend:
        project_kind = "ios"
    elif android and not ios and not frontend and not backend:
        project_kind = "android"
    elif frontend and backend:
        project_kind = "fullstack"
    elif frontend:
        project_kind = "frontend"
    elif backend:
        project_kind = "backend"
    elif ios or android:
        project_kind = "mobile"
    elif infra and not (frontend or backend or ios or android):
        project_kind = "infra"
    elif signals:
        project_kind = "general"
    else:
        project_kind = "unknown"

    return project_kind, suggestions
