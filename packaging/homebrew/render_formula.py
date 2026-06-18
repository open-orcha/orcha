#!/usr/bin/env python3
"""Render the Homebrew formulae for a release: a tracking Formula/orcha.rb plus a
frozen Formula/orcha@X.Y.Z.rb (the downgrade target). Pure stdlib — used by
.github/workflows/publish.yml and runnable by hand.

Usage: render_formula.py VERSION REVISION OUT_DIR
  VERSION   release version, X.Y.Z (no leading v)
  REVISION  full 40-char commit sha the cli-vX.Y.Z tag points at
  OUT_DIR   directory to write orcha.rb and orcha@X.Y.Z.rb into
"""
import pathlib
import re
import sys

TEMPLATE = pathlib.Path(__file__).with_name("orcha.rb.tmpl")


def class_name(formula_name: str) -> str:
    """Homebrew's name→class rule: capitalize -/_ segments; '@' becomes 'AT' with
    non-alphanumerics dropped: orcha@0.2.1 → OrchaAT021 (cf. python@3.13 → PythonAT313)."""
    base, _, ver = formula_name.partition("@")
    cls = "".join(seg.capitalize() for seg in re.split(r"[-_]", base))
    if ver:
        cls += "AT" + re.sub(r"[^A-Za-z0-9]", "", ver)
    return cls


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
    )


def main() -> None:
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
