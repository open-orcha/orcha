#!/usr/bin/env python3
"""Render the Homebrew formulae for a release: a tracking Formula/orcha.rb plus a
frozen Formula/orcha@X.Y.Z.rb (the downgrade target). Pure stdlib — used by
.github/workflows/publish.yml and runnable by hand.

Usage: render_formula.py VERSION REVISION OUT_DIR
  VERSION   release version, X.Y.Z (no leading v)
  REVISION  full 40-char commit sha the cli-vX.Y.Z tag points at
  OUT_DIR   directory to write orcha.rb and orcha@X.Y.Z.rb into

       render_formula.py lock
  Re-resolve orcha-cli's runtime dependencies (orcha-cli/pyproject.toml) and rewrite
  resources.json, the pinned sdist list the formula's `resource` blocks come from.
  Needs network (pip + PyPI); run it whenever the pyproject dependencies change.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "orcha.rb.tmpl"
RESOURCES = HERE / "resources.json"
PYPROJECT = HERE.parents[1] / "orcha-cli" / "pyproject.toml"
FORMULA_PYTHON = "3.13"   # keep in step with `depends_on "python@3.13"` in the template
# Homebrew builds every resource from its sdist, and psycopg-binary ships wheels only.
# The formula installs pure psycopg and `depends_on "libpq"` instead (as pgcli does).
FORMULA_REQUIREMENT_SWAPS = {"psycopg[binary]": "psycopg"}


def class_name(formula_name: str) -> str:
    """Homebrew's name→class rule: capitalize -/_ segments; '@' becomes 'AT' with
    non-alphanumerics dropped: orcha@0.2.1 → OrchaAT021 (cf. python@3.13 → PythonAT313)."""
    base, _, ver = formula_name.partition("@")
    cls = "".join(seg.capitalize() for seg in re.split(r"[-_]", base))
    if ver:
        cls += "AT" + re.sub(r"[^A-Za-z0-9]", "", ver)
    return cls


def normalize(name: str) -> str:
    """PEP 503 project-name normalization (Homebrew resource names use it too)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def pyproject_requirements() -> list[str]:
    """orcha-cli's runtime dependencies, as the formula installs them."""
    import tomllib
    deps = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["dependencies"]
    out = []
    for dep in deps:
        for old, new in FORMULA_REQUIREMENT_SWAPS.items():
            if dep.startswith(old):
                dep = new + dep[len(old):]
        out.append(re.sub(r"\[[^\]]*\]", "", dep))   # extras are wheel conveniences only
    return out


def resource_blocks() -> str:
    """One `resource` block per pinned sdist in resources.json, sorted by name."""
    blocks = []
    for res in sorted(json.loads(RESOURCES.read_text(encoding="utf-8")), key=lambda r: r["name"]):
        blocks.append(
            f'  resource "{res["name"]}" do\n'
            f'    url "{res["url"]}"\n'
            f'    sha256 "{res["sha256"]}"\n'
            "  end\n"
        )
    return "\n".join(blocks)


def lock() -> None:
    """Resolve the dependency closure for the formula's Python, pin each sdist."""
    with tempfile.TemporaryDirectory() as tmp:
        report = pathlib.Path(tmp) / "report.json"
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--dry-run", "--quiet",
             "--ignore-installed", "--only-binary=:all:", "--target", tmp,
             "--python-version", FORMULA_PYTHON, "--report", str(report),
             *pyproject_requirements()],
            check=True,
        )
        pins = [(i["metadata"]["name"], i["metadata"]["version"])
                for i in json.loads(report.read_text())["install"]]
    resources = []
    for name, version in pins:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json") as resp:
            files = json.load(resp)["urls"]
        sdist = next((f for f in files if f["packagetype"] == "sdist"), None)
        if sdist is None:
            sys.exit(f"error: {name}=={version} has no sdist; Homebrew cannot build it")
        resources.append({"name": normalize(name), "version": version,
                          "url": sdist["url"], "sha256": sdist["digests"]["sha256"]})
    resources.sort(key=lambda r: r["name"])
    RESOURCES.write_text(json.dumps(resources, indent=2) + "\n", encoding="utf-8")
    print(f"pinned {len(resources)} resources -> {RESOURCES}")


def render(version: str, revision: str, *, versioned: bool) -> str:
    name = f"orcha@{version}" if versioned else "orcha"
    conflicts = (
        "\n  # A frozen downgrade target — can't coexist with the tracking formula.\n"
        '  conflicts_with "orcha", because: "both install an `orcha` binary"\n\n'
        if versioned else "\n"
    )
    return (
        TEMPLATE.read_text(encoding="utf-8")
        .replace("{{CLASS_NAME}}", class_name(name))
        .replace("{{VERSION}}", version)
        .replace("{{REVISION}}", revision)
        .replace("{{CONFLICTS}}", conflicts)
        .replace("{{RESOURCES}}", resource_blocks())
    )


def main() -> None:
    if sys.argv[1:] == ["lock"]:
        return lock()
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    version, revision, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"error: VERSION must be X.Y.Z (no leading v), got {version!r}")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        sys.exit(f"error: REVISION must be a full 40-char commit sha, got {revision!r}")
    out.mkdir(parents=True, exist_ok=True)
    (out / "orcha.rb").write_text(render(version, revision, versioned=False), encoding="utf-8")
    (out / f"orcha@{version}.rb").write_text(render(version, revision, versioned=True), encoding="utf-8")
    print(f"rendered orcha.rb + orcha@{version}.rb -> {out}")


if __name__ == "__main__":
    main()
