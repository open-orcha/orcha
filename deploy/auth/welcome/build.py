#!/usr/bin/env python3
"""Assemble the Orcha marketing landing page.

Reads `index.template.html`, replaces each `<!-- @section:NAME -->` marker with
the verbatim contents of `sections/NAME.html`, and writes `index.html`.

Each section is a self-contained fragment (its own <style> + <script> live
inside the <section> element); the assembler does no transformation beyond
substitution — what a section agent writes is what ships.

Usage:
    python3 build.py                 # fail loudly if any fragment is missing
    python3 build.py --allow-missing # substitute a visible placeholder comment
                                     # for missing fragments (preview before all land)

Exits non-zero (listing the missing fragments) unless every marker resolves or
--allow-missing is passed. No third-party dependencies — stdlib only.
"""
import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "index.template.html"
SECTIONS_DIR = HERE / "sections"
OUTPUT = HERE / "index.html"

# One marker per section; the ORDER here is documentation only — the template
# decides placement. Matches: <!-- @section:NAME --> (any surrounding whitespace).
MARKER_RE = re.compile(r"[ \t]*<!--[ \t]*@section:([a-z0-9_-]+)[ \t]*-->[ \t]*")


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble index.html from the template + section fragments.")
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="substitute an HTML comment placeholder for any missing fragment instead of failing",
    )
    args = parser.parse_args()

    if not TEMPLATE.exists():
        print(f"error: template not found: {TEMPLATE}", file=sys.stderr)
        return 2

    template = TEMPLATE.read_text(encoding="utf-8")

    missing: list[str] = []
    resolved: list[str] = []

    def replace(match: "re.Match[str]") -> str:
        name = match.group(1)
        fragment = SECTIONS_DIR / f"{name}.html"
        if fragment.exists():
            resolved.append(name)
            return fragment.read_text(encoding="utf-8")
        missing.append(name)
        if args.allow_missing:
            return (
                f"\n<!-- @section:{name} — MISSING at build time "
                f"(placeholder inserted by build.py --allow-missing) -->\n"
            )
        # leave the marker as-is; we fail below before writing output
        return match.group(0)

    assembled = MARKER_RE.sub(replace, template)

    if missing and not args.allow_missing:
        print("error: missing section fragment(s):", file=sys.stderr)
        for name in missing:
            print(f"  - sections/{name}.html", file=sys.stderr)
        print(
            "\nWrite the fragment(s), or run `python3 build.py --allow-missing` to "
            "preview with placeholders.",
            file=sys.stderr,
        )
        return 1

    OUTPUT.write_text(assembled, encoding="utf-8")

    if resolved:
        print(f"assembled {len(resolved)} section(s): {', '.join(resolved)}")
    if missing and args.allow_missing:
        print(f"placeholders for {len(missing)} missing section(s): {', '.join(missing)}")
    print(f"wrote {OUTPUT.relative_to(HERE)} ({OUTPUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
