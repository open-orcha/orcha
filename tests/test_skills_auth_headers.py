"""Auth v1 (#271): every skill template's API curl must send the Authorization header.

On an enforce-mode stack an unauthenticated /api/* call 401s — a skill whose curl
lacks the header is a latent break that only shows up on new (enforce-default)
projects. This lint keeps the whole template set honest, including future skills.
"""
import pathlib
import re

SKILLS_DIR = (pathlib.Path(__file__).resolve().parent.parent
              / "orcha-cli" / "orcha_cli" / "templates" / "skills")


def _curl_blocks(text):
    """Yield (start_line_no, block_text) for each curl invocation, following
    backslash continuations."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if "curl " in lines[i]:
            block = [lines[i]]
            j = i
            while lines[j].rstrip().endswith("\\") and j + 1 < len(lines):
                j += 1
                block.append(lines[j])
            yield i + 1, "\n".join(block)
            i = j + 1
        else:
            i += 1


def test_every_api_curl_sends_authorization():
    assert SKILLS_DIR.is_dir()
    missing = []
    for md in sorted(SKILLS_DIR.glob("*.md")):
        for lineno, block in _curl_blocks(md.read_text()):
            if "<api_base_url>/api" not in block:
                continue
            if "Authorization: Bearer" not in block:
                missing.append(f"{md.name}:{lineno}")
    assert not missing, (
        "API curls without an Authorization header (401 on enforce-mode stacks): "
        + ", ".join(missing))


def test_register_skills_persist_the_token():
    """The register skills write the binding file — they must persist the token the
    API returns exactly once, or the agent can never authenticate."""
    for name in ("orcha-register-agent.md", "orcha-register-human.md"):
        text = (SKILLS_DIR / name).read_text()
        assert re.search(r'"token"', text), (
            f"{name} must instruct persisting the register response's token "
            f"into the binding JSON")
