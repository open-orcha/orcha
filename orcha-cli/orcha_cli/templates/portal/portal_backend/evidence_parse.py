"""Proof-of-work evidence — the PURE half (no DB, no network).

Everything here turns what a task's runs actually recorded into evidence a human can check:

  * `extract_commands(output)` — the shell commands an agent ran, with their captured output and
    exit status, from a worker run's stream-json (Claude Code `tool_use`/`tool_result` pairs and
    the Codex `command_execution` / exec events).
  * `test_invocations(commands)` — the commands that ran a test suite, with the pass/fail counts
    parsed from the runner's OWN summary line (pytest, vitest, jest, mocha, go, cargo, unittest,
    XCTest / Swift Testing, rspec, phpunit, dotnet, maven/gradle). No summary line → no counts
    (the exit status is reported instead, or "unknown"): counts are never invented.
  * `analyze_changes(files, patch)` — a plain-English summary of the changed files plus
    deterministic risk flags (migrations, auth, secrets, deletions, large diffs, dependencies,
    CI/infra).
  * `split_dod(text)` / `assess_dod(...)` — each definition-of-done line classified as
    proven / not_proven / needs_human with the evidence line that supports it. Heuristic and
    deterministic; the agent's own report is attached only as a clearly-labelled CLAIM and
    never changes an item's status.
"""

from __future__ import annotations

import json
import re
import shlex
from typing import Any, Iterable

# ------------------------------------------------------------------ commands from run output

MAX_OUTPUT_CHARS = 200_000  # one command's captured output kept for parsing


def _text_of(v: Any) -> str:
    """Visible text of a tool_result `content` (str, list of blocks, or nested dicts)."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, list):
        return "\n".join(t for t in (_text_of(x) for x in v) if t)
    if isinstance(v, dict):
        for k in ("text", "output", "aggregated_output", "stdout", "content", "formatted_output"):
            if k in v and v[k] is not None:
                return _text_of(v[k])
    return ""


def _iter_json_lines(output: str) -> Iterable[dict]:
    for raw in (output or "").splitlines():
        s = raw.strip()
        if not s or s[0] != "{":
            continue
        try:
            o = json.loads(s)
        except ValueError:
            continue
        if isinstance(o, dict):
            yield o


def _codex_command(v: Any) -> str:
    if isinstance(v, list):
        parts = [str(x) for x in v]
        # ["bash", "-lc", "pytest -q"] -> the script
        if len(parts) >= 3 and parts[0].endswith(("bash", "sh", "zsh")) and parts[1].startswith("-") and "c" in parts[1]:
            return parts[2]
        return " ".join(shlex.quote(p) for p in parts)
    return str(v or "")


def extract_commands(output: str) -> list[dict]:
    """Shell commands in a run's stream-json, in order:
    [{command, output, exit_code (int|None), is_error (bool|None), index}].

    Claude Code: an assistant `tool_use` block named Bash (input.command) paired with the
    user `tool_result` carrying the same tool_use_id. Codex: `item.completed` /
    `exec_command_end` style events carrying the command and its aggregated output + exit
    code. A command whose result never arrived is kept with output "" and exit None."""
    cmds: list[dict] = []
    pending: dict[str, dict] = {}
    codex_open: dict[str, dict] = {}
    for o in _iter_json_lines(output):
        typ = str(o.get("type") or "")
        msg = o.get("message") if isinstance(o.get("message"), dict) else None
        # ---- Claude Code stream-json
        if msg is not None and isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if not isinstance(block, dict):
                    continue
                bt = block.get("type")
                if bt == "tool_use" and str(block.get("name") or "") in ("Bash", "bash", "shell", "Shell"):
                    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                    c = {"command": str(inp.get("command") or ""), "output": "", "exit_code": None,
                         "is_error": None, "index": len(cmds)}
                    cmds.append(c)
                    if block.get("id"):
                        pending[str(block["id"])] = c
                elif bt == "tool_result":
                    c = pending.pop(str(block.get("tool_use_id") or ""), None)
                    if c is None:
                        continue
                    text = _text_of(block.get("content"))
                    c["output"] = text[-MAX_OUTPUT_CHARS:]
                    c["is_error"] = bool(block.get("is_error")) if block.get("is_error") is not None else None
                    m = re.match(r"\s*Exit code (\d+)", text or "")
                    if m:
                        c["exit_code"] = int(m.group(1))
                    elif c["is_error"] is False:
                        c["exit_code"] = 0
            # Claude also mirrors the structured result under tool_use_result
            continue
        # ---- Codex exec events (several envelope generations)
        p = o.get("msg") if isinstance(o.get("msg"), dict) else o
        item = p.get("item") if isinstance(p.get("item"), dict) else None
        ptype = str(p.get("type") or typ)
        if item is not None and str(item.get("type") or "") in ("command_execution", "local_shell_call", "exec_command"):
            key = str(item.get("id") or "")
            if ptype.endswith("started"):
                c = {"command": _codex_command(item.get("command")), "output": "", "exit_code": None,
                     "is_error": None, "index": len(cmds)}
                cmds.append(c)
                if key:
                    codex_open[key] = c
                continue
            c = codex_open.pop(key, None) if key else None
            if c is None:
                c = {"command": _codex_command(item.get("command")), "output": "", "exit_code": None,
                     "is_error": None, "index": len(cmds)}
                cmds.append(c)
            c["output"] = _text_of(item.get("aggregated_output") or item.get("output") or "")[-MAX_OUTPUT_CHARS:]
            if isinstance(item.get("exit_code"), int):
                c["exit_code"] = item["exit_code"]
                c["is_error"] = item["exit_code"] != 0
            continue
        if ptype in ("exec_command_begin",):
            c = {"command": _codex_command(p.get("command")), "output": "", "exit_code": None,
                 "is_error": None, "index": len(cmds)}
            cmds.append(c)
            if p.get("call_id"):
                codex_open[str(p["call_id"])] = c
        elif ptype in ("exec_command_end",):
            c = codex_open.pop(str(p.get("call_id") or ""), None)
            if c is None:
                c = {"command": _codex_command(p.get("command")), "output": "", "exit_code": None,
                     "is_error": None, "index": len(cmds)}
                cmds.append(c)
            out = p.get("aggregated_output") or p.get("formatted_output") or ((p.get("stdout") or "") + (p.get("stderr") or ""))
            c["output"] = _text_of(out)[-MAX_OUTPUT_CHARS:]
            if isinstance(p.get("exit_code"), int):
                c["exit_code"] = p["exit_code"]
                c["is_error"] = p["exit_code"] != 0
    return cmds


# ------------------------------------------------------------------ test detection + counts

_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")
_WRAPPERS = {"timeout", "time", "env", "nice", "exec", "command", "xvfb-run", "caffeinate", "sudo"}
_RUNNERS_2 = {  # two-token prefixes that wrap a runner
    ("uv", "run"), ("poetry", "run"), ("pipenv", "run"), ("pnpm", "exec"), ("yarn", "exec"),
    ("bundle", "exec"), ("npm", "exec"), ("hatch", "run"), ("pdm", "run"), ("rye", "run"),
}

_TEST_HEADS: list[tuple[str, re.Pattern]] = [
    ("pytest", re.compile(r"^(pytest|py\.test)$")),
    ("vitest", re.compile(r"^vitest$")),
    ("jest", re.compile(r"^jest$")),
    ("mocha", re.compile(r"^mocha$")),
    ("playwright", re.compile(r"^playwright$")),
    ("rspec", re.compile(r"^rspec$")),
    ("phpunit", re.compile(r"^phpunit$")),
    ("tox", re.compile(r"^(tox|nox)$")),
]


def _segments(command: str) -> list[str]:
    """Top-level command segments (split on && || ; | and newlines), with `bash -lc '…'`
    style wrappers unwrapped."""
    cmd = command or ""
    m = re.match(r"""^\s*(?:/bin/|/usr/bin/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+(['"])(.*)\1\s*$""", cmd, re.S)
    if m:
        cmd = m.group(2)
    return [s.strip() for s in re.split(r"&&|\|\||;|\n|\|", cmd) if s.strip()]


def _tokens(segment: str) -> list[str]:
    try:
        toks = shlex.split(segment, comments=False)
    except ValueError:
        toks = segment.split()
    out = list(toks)
    # strip env assignments and wrappers (timeout 60 …)
    while out:
        t = out[0]
        base = t.rsplit("/", 1)[-1]
        if _ENV_ASSIGN.match(t):
            out.pop(0)
            continue
        if base in _WRAPPERS:
            out.pop(0)
            while out and (out[0].startswith("-") or re.match(r"^\d+[smh]?$", out[0])):
                out.pop(0)
            continue
        if len(out) >= 2 and (base, out[1]) in _RUNNERS_2:
            out = out[2:]
            continue
        if base in ("npx", "bunx", "pnpx"):
            out.pop(0)
            while out and out[0].startswith("-"):
                out.pop(0)
            continue
        break
    return out


# package-manager options that take a VALUE (`npm --prefix web test`, `pnpm -C web test`,
# `pnpm --filter api test`, `yarn --cwd web test`, `npm -w pkg test`)
_PM_VALUE_OPTS = {"--prefix", "-C", "--dir", "--cwd", "--filter", "-F", "-w", "--workspace"}
_SCRIPT_TEST = re.compile(r"^(test|tests|test:[\w:.-]+|e2e|check)$")
# the wrappers whose real runner is unknown until its output reveals it
SCRIPT_WRAPPERS = ("npm ", "pnpm ", "yarn ", "bun run", "node --run", "make ")


def _pm_args(rest: list[str]) -> list[str]:
    """The positional args of an npm/pnpm/yarn/bun command line (options and their values
    dropped; everything after `--` belongs to the script and is ignored)."""
    args: list[str] = []
    skip = False
    for a in rest:
        if skip:
            skip = False
            continue
        if a == "--":
            break
        if a.startswith("-"):
            if a in _PM_VALUE_OPTS:
                skip = True
            continue
        args.append(a)
    if args[:1] == ["workspace"] and len(args) >= 2:  # yarn workspace <pkg> test
        args = args[2:]
    return args


def _node_runs_tests(rest: list[str]) -> bool:
    """`node --test …` / `node --test-reporter=spec --test` / `node --import tsx --test`."""
    return any(a == "--test" or a.startswith("--test=") or a.startswith("--test-") for a in rest)


def test_framework(command: str) -> str | None:
    """The test framework a command runs, or None when it does not run tests.

    Only the HEAD of a segment counts (`grep pytest foo` is not a test run). A package
    script (`npm test`, `pnpm run test:unit`, `yarn test`, `node --run test`) is reported by
    its command — the runner behind it is unknown until its output reveals it (see
    `test_invocations`)."""
    for seg in _segments(command):
        toks = _tokens(seg)
        if not toks:
            continue
        head = toks[0].rsplit("/", 1)[-1]
        rest = toks[1:]
        for name, rx in _TEST_HEADS:
            if rx.match(head):
                if name == "playwright" and (not rest or rest[0] != "test"):
                    break
                return name
        if re.match(r"^python[0-9.]*$", head) and len(rest) >= 2 and rest[0] == "-m":
            if rest[1] in ("pytest", "unittest"):
                return rest[1]
            if rest[1] == "tox":
                return "tox"
        if re.match(r"^(node|nodejs|tsx)$", head):
            if _node_runs_tests(rest):
                return "node --test"
            # `node test/cart.test.mjs` — a node:test file run directly
            if rest and not rest[0].startswith("-") and re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", rest[0]):
                return "node --test"
            if "--run" in rest:  # node 22+: `node --run test` runs a package.json script
                i = rest.index("--run")
                if i + 1 < len(rest) and _SCRIPT_TEST.match(rest[i + 1]):
                    return "node --run " + rest[i + 1]
            continue
        if head in ("npm", "pnpm", "yarn", "bun"):
            args = _pm_args(rest)
            if args[:1] == ["test"] or args[:1] == ["t"] or args[:1] == ["tst"]:
                return head + " test"
            if len(args) >= 2 and args[0] in ("run", "run-script", "rs") and _SCRIPT_TEST.match(args[1]):
                return head + " " + args[1]
            if head in ("yarn", "pnpm") and args[:1] and re.match(r"^test(:[\w:.-]+)?$", args[0]):
                return head + " " + args[0]
        if head == "go" and rest[:1] == ["test"]:
            return "go test"
        if head == "cargo" and rest[:1] in (["test"], ["nextest"]):
            return "cargo test"
        if head == "swift" and rest[:1] == ["test"]:
            return "swift test"
        if head == "xcodebuild" and any(a in ("test", "test-without-building") for a in rest):
            return "xcodebuild test"
        if head in ("mvn", "mvnw", "./mvnw") and any(a in ("test", "verify") for a in rest):
            return "maven"
        if head in ("gradle", "gradlew") and any(re.match(r"^(test|check|\w*Test\w*)$", a) for a in rest):
            return "gradle"
        if head == "dotnet" and rest[:1] == ["test"]:
            return "dotnet test"
        if head in ("mix", "deno", "bun") and rest[:1] == ["test"]:
            return head + " test"
        if head == "rake" and rest[:1] in (["test"], ["spec"]):
            return "rake test"
        if head == "make" and rest[:1] and re.match(r"^(test|tests|check)$", rest[0]):
            return "make " + rest[0]
    return None


_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _clean(text: str) -> str:
    return _ANSI.sub("", text or "")


def _num(rx: str, text: str, flags=re.I) -> int | None:
    m = None
    for m in re.finditer(rx, text, flags):
        pass
    return int(m.group(1)) if m else None


def _counts(passed=0, failed=0, skipped=0, errors=0, total=None, unit="tests", source="", runner=None):
    total = total if total is not None else passed + failed + skipped + errors
    return {"passed": passed, "failed": failed, "skipped": skipped, "errors": errors,
            "total": total, "unit": unit, "source": source.strip()[:200], "runner": runner}


# node's built-in runner (and other TAP producers such as tape) end with a summary block:
#   TAP / node 20-22 non-TTY default:  "# tests 35" "# pass 34" "# fail 1" "# cancelled 0"
#                                      "# skipped 0" "# todo 0" (+ "# suites", "# duration_ms")
#   spec reporter / node 23+ default:  "ℹ tests 35" "ℹ pass 34" "ℹ fail 1" …
_NODE_SUMMARY_LINE = re.compile(r"^[ \t]*([#ℹ])[ \t]+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)"
                                r"[ \t]+(\d+(?:\.\d+)?)[ \t]*$", re.M)


def _node_counts(text: str) -> dict | None:
    """Counts from node:test / TAP summary blocks. Each block starts at a `tests N` line;
    blocks are SUMMED (`npm test --workspaces` prints one per workspace) so a failing block
    is never hidden behind a later passing one. None without a `tests` + `pass` pair."""
    blocks: list[dict[str, int]] = []
    cur: dict[str, int] | None = None
    last_end = -1
    for m in _NODE_SUMMARY_LINE.finditer(text):
        key, val = m.group(2), m.group(3)
        # a block is contiguous summary lines (same marker); anything else between ends it
        contiguous = cur is not None and text[last_end:m.start()].strip() == ""
        if key == "tests" or not contiguous:
            cur = {}
            blocks.append(cur)
        if key != "duration_ms":
            cur[key] = int(val)
        last_end = m.end()
    blocks = [b for b in blocks if "tests" in b and "pass" in b]
    if not blocks:
        return None
    tot = {k: sum(b.get(k, 0) for b in blocks) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    marker = "ℹ" if re.search(r"^[ \t]*ℹ[ \t]+tests[ \t]+\d", text, re.M) else "#"
    src = (f"node:test: {marker} tests {tot['tests']}, pass {tot['pass']}, fail {tot['fail']}"
           + (f", cancelled {tot['cancelled']}" if tot["cancelled"] else "")
           + (f", skipped {tot['skipped']}" if tot["skipped"] else "")
           + (f", todo {tot['todo']}" if tot["todo"] else "")
           + (f" ({len(blocks)} summaries)" if len(blocks) > 1 else ""))
    # a cancelled test did not pass (node exits 1): it counts as an error, never a pass
    return _counts(tot["pass"], tot["fail"], tot["skipped"] + tot["todo"], tot["cancelled"],
                   total=tot["tests"], source=src, runner="node:test")


# go test package lines — strict: `ok  <pkg>  <duration>|(cached)` and
# `FAIL <pkg> <duration>|[build failed]|[setup failed]`. A TAP line ("ok 2 - name") never
# matches: its second token is a number and no duration follows.
_GO_DUR = r"(?:\d+(?:\.\d+)?s|\(cached\))"
_GO_OK = re.compile(r"^ok[ \t]+(?!\d+[ \t]+-)([\w.~+-]+(?:/[\w.~+-]+)*)[ \t]+" + _GO_DUR + r"(?:[ \t].*)?$", re.M)
_GO_FAIL = re.compile(r"^FAIL[ \t]+([\w.~+-]+(?:/[\w.~+-]+)*)[ \t]+(?:" + _GO_DUR +
                      r"|\[(?:build failed|setup failed)\])[ \t]*$", re.M)


def _go_counts(text: str) -> dict | None:
    ok_pk = [p for p in _GO_OK.findall(text) if not p.isdigit()]
    fail_pk = [p for p in _GO_FAIL.findall(text) if not p.isdigit()]
    if not ok_pk and not fail_pk:
        return None
    return _counts(len(ok_pk), len(fail_pk), unit="packages",
                   source=f"go: {len(ok_pk)} ok, {len(fail_pk)} FAIL", runner="go")


def parse_test_counts(output: str) -> dict | None:
    """Pass/fail counts from a test runner's own summary line, or None when no known summary
    line is present. Takes the LAST summary in the output (a watch/rerun prints several) —
    except cargo and node:test, whose per-binary / per-workspace summaries are summed.
    `runner` names the runner the output revealed (None when unknown)."""
    text = _clean(output)
    if not text.strip():
        return None
    lines = text.splitlines()

    # cargo: sum every "test result:" line (one per test binary)
    cargo = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", text)
    if cargo:
        p = sum(int(a) for a, _, _ in cargo)
        f = sum(int(b) for _, b, _ in cargo)
        s = sum(int(c) for _, _, c in cargo)
        return _counts(p, f, s, source=f"cargo: {len(cargo)} test binaries", runner="cargo")

    # node:test (TAP / spec) — before the generic parsers: its summary is unambiguous, and a
    # failing test's message must not be mistaken for another runner's summary
    node = _node_counts(text)
    if node is not None:
        return node

    # vitest: " Tests  1 failed | 41 passed | 2 skipped (44)"
    for line in reversed(lines):
        if re.match(r"^\s*Tests\s{1,}\d", line) and "|" in line or re.match(r"^\s*Tests\s+\d+ (passed|failed)", line):
            if re.match(r"^\s*Tests:", line):
                continue
            kv = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|skipped|todo)", line)}
            if kv:
                tot = re.search(r"\((\d+)\)", line)
                return _counts(kv.get("passed", 0), kv.get("failed", 0), kv.get("skipped", 0) + kv.get("todo", 0),
                               total=int(tot.group(1)) if tot else None, source=line, runner="vitest")

    # jest: "Tests:       1 failed, 41 passed, 42 total"
    for line in reversed(lines):
        if re.match(r"^\s*Tests:\s+", line):
            kv = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|skipped|todo|total)", line)}
            if kv:
                return _counts(kv.get("passed", 0), kv.get("failed", 0), kv.get("skipped", 0) + kv.get("todo", 0),
                               total=kv.get("total"), source=line, runner="jest")

    # pytest: "==== 1 failed, 41 passed, 2 skipped in 3.21s ====" or -q "41 passed in 0.5s"
    for line in reversed(lines):
        if re.search(r"\b\d+ (passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b", line) and \
                re.search(r"\bin [\d.]+s\b", line) and not re.match(r"^\s*Tests?:", line):
            kv: dict[str, int] = {}
            for v, k in re.findall(r"(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)", line):
                k = "errors" if k.startswith("error") else k
                kv[k] = kv.get(k, 0) + int(v)
            if any(k in kv for k in ("passed", "failed", "errors", "skipped")):
                return _counts(kv.get("passed", 0) + kv.get("xpassed", 0), kv.get("failed", 0),
                               kv.get("skipped", 0) + kv.get("xfailed", 0), kv.get("errors", 0),
                               source=line.strip(" ="), runner="pytest")
        if re.search(r"\bno tests ran\b", line):
            return _counts(0, 0, 0, source=line.strip(" ="), runner="pytest")

    # unittest: "Ran 12 tests in 0.01s" + "OK" / "FAILED (failures=1, errors=2)"
    ran = _num(r"^Ran (\d+) tests? in", text, re.M)
    if ran is not None:
        f = _num(r"FAILED \([^)]*failures=(\d+)", text) or 0
        e = _num(r"FAILED \([^)]*errors=(\d+)", text) or 0
        s = _num(r"(?:OK|FAILED) \([^)]*skipped=(\d+)", text) or 0
        return _counts(max(ran - f - e - s, 0), f, s, e, total=ran, source=f"Ran {ran} tests", runner="unittest")

    # mocha: "41 passing", "1 failing", "2 pending"
    passing = _num(r"^\s*(\d+) passing\b", text, re.M)
    if passing is not None:
        failing = _num(r"^\s*(\d+) failing\b", text, re.M) or 0
        pending = _num(r"^\s*(\d+) pending\b", text, re.M) or 0
        return _counts(passing, failing, pending, source=f"{passing} passing", runner="mocha")

    # XCTest: "Executed 42 tests, with 1 failure (0 unexpected)"
    m = None
    for m in re.finditer(r"Executed (\d+) tests?, with (\d+) failures?", text):
        pass
    if m:
        t, f = int(m.group(1)), int(m.group(2))
        return _counts(t - f, f, total=t, source=m.group(0), runner="xctest")
    # Swift Testing: "Test run with 12 tests passed" / "Test run with 12 tests failed … with 2 issues"
    m = None
    for m in re.finditer(r"Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)(?:.*?with (\d+) issues?)?", text):
        pass
    if m:
        t = int(m.group(1))
        if m.group(2) == "passed":
            return _counts(t, 0, total=t, source=m.group(0), runner="swift-testing")
        return _counts(0, 0, total=t, errors=0, source=m.group(0), runner="swift-testing") | {"failed": int(m.group(3) or 1),
                                                                    "passed": max(t - int(m.group(3) or 1), 0)}

    # rspec: "42 examples, 1 failure, 2 pending"
    m = None
    for m in re.finditer(r"(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?", text):
        pass
    if m:
        t, f, pnd = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        return _counts(t - f - pnd, f, pnd, total=t, source=m.group(0), runner="rspec")

    # dotnet: "Passed!  - Failed: 0, Passed: 42, Skipped: 0, Total: 42"
    m = None
    for m in re.finditer(r"Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)", text):
        pass
    if m:
        return _counts(int(m.group(2)), int(m.group(1)), int(m.group(3)), total=int(m.group(4)), source=m.group(0), runner="dotnet")

    # phpunit: "OK (42 tests, 90 assertions)" / "Tests: 42, Assertions: 90, Failures: 1, Errors: 0"
    m = None
    for m in re.finditer(r"OK \((\d+) tests?, \d+ assertions?\)", text):
        pass
    if m:
        return _counts(int(m.group(1)), 0, source=m.group(0), runner="phpunit")
    m = None
    for m in re.finditer(r"Tests: (\d+), Assertions: \d+(?:, Errors: (\d+))?(?:, Failures: (\d+))?(?:, Skipped: (\d+))?", text):
        pass
    if m:
        t = int(m.group(1))
        e, f, s = int(m.group(2) or 0), int(m.group(3) or 0), int(m.group(4) or 0)
        return _counts(max(t - e - f - s, 0), f, s, e, total=t, source=m.group(0), runner="phpunit")

    # maven / gradle surefire: "Tests run: 42, Failures: 1, Errors: 0, Skipped: 2"
    m = None
    for m in re.finditer(r"Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)", text):
        pass
    if m:
        t, f, e, s = (int(m.group(i)) for i in range(1, 5))
        return _counts(max(t - f - e - s, 0), f, s, e, total=t, source=m.group(0), runner="junit")

    # go test: count package lines ("ok  pkg 0.1s" / "FAIL pkg 0.2s") — strict, see _GO_OK
    return _go_counts(text)


def test_invocations(commands: list[dict], run_id: str | None = None) -> list[dict]:
    """The test-suite commands among `commands`, each with parsed counts (or None) and an
    outcome: passed | failed | no_tests | exit_ok (exit 0, no summary line) |
    exit_failed (non-zero exit, no summary line) | unknown (no result captured)."""
    out = []
    for c in commands:
        fw = test_framework(c.get("command") or "")
        if not fw:
            continue
        counts = parse_test_counts(c.get("output") or "")
        exit_code = c.get("exit_code")
        if counts is not None:
            if counts["failed"] or counts["errors"]:
                outcome = "failed"
            elif counts["passed"]:
                outcome = "passed"
            else:
                outcome = "no_tests"
        elif exit_code == 0:
            outcome = "exit_ok"
        elif exit_code is not None or c.get("is_error"):
            outcome = "exit_failed"
        else:
            outcome = "unknown"
        runner = (counts or {}).get("runner")
        if runner and fw.startswith(SCRIPT_WRAPPERS) and runner not in fw:
            # `npm test` is a test of unknown framework until its output names the runner
            fw = f"{fw} ({runner})"
        out.append({
            "run_id": run_id,
            "framework": fw,
            "runner": runner,
            "command": (c.get("command") or "")[:400],
            "exit_code": exit_code,
            "counts": counts,
            "outcome": outcome,
            "index": c.get("index"),
        })
    return out


def _norm_cmd(cmd: str) -> str:
    return re.sub(r"\s+", " ", cmd or "").strip()


def summarize_tests(invocations: list[dict]) -> dict:
    """The LATEST invocation of each distinct command counts (an agent reruns a suite after a
    fix); earlier ones stay listed as history. Returns {status, passed, failed, skipped,
    errors, suites, invocations, latest:[…], earlier:int}.

    status: none (no test command ran) | passed | failed | unverified (tests ran but no
    counts and no failing signal could be read)."""
    latest: dict[str, dict] = {}
    for inv in invocations:
        latest[_norm_cmd(inv["command"])] = inv  # later wins (invocations are in run order)
    chosen = list(latest.values())
    tot = {"passed": 0, "failed": 0, "skipped": 0, "errors": 0}
    counted = 0
    failing_signal = False
    for inv in chosen:
        c = inv.get("counts")
        if c and c.get("unit") == "tests":
            counted += 1
            for k in tot:
                tot[k] += int(c.get(k) or 0)
        elif c:  # go packages: count as suites, not tests
            counted += 1
            if c.get("failed"):
                failing_signal = True
        if inv["outcome"] in ("failed", "exit_failed"):
            failing_signal = True
    if not chosen:
        status = "none"
    elif failing_signal or tot["failed"] or tot["errors"]:
        status = "failed"
    elif tot["passed"] or any(inv["outcome"] in ("passed",) for inv in chosen):
        status = "passed"
    elif all(inv["outcome"] == "exit_ok" for inv in chosen):
        status = "exit_ok"
    else:
        status = "unverified"
    return {
        "status": status,
        **tot,
        "suites": len(chosen),
        "counted_suites": counted,
        "invocations": len(invocations),
        "latest": chosen,
        "earlier": len(invocations) - len(chosen),
    }


# ------------------------------------------------------------------ changes: summary + risk

_TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec|e2e)(/|$)|(^|/)test_[^/]+$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$", re.I)
_MIGRATION_PATH = re.compile(r"(^|/)(migrations?|alembic|db/migrate)(/|$)|\.sql$|(^|/)schema\.prisma$", re.I)
_DOC_PATH = re.compile(r"\.(md|mdx|rst|txt|adoc)$|(^|/)docs?/", re.I)
_DEP_PATH = re.compile(
    r"(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|requirements[^/]*\.txt|"
    r"pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|"
    r"Podfile(\.lock)?|Package\.(swift|resolved)|build\.gradle(\.kts)?|pom\.xml|composer\.(json|lock))$", re.I)
_CI_PATH = re.compile(r"(^|/)\.github/workflows/|(^|/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|"
                      r"\.tf$|(^|/)\.gitlab-ci\.yml$|(^|/)Jenkinsfile$|(^|/)\.circleci/", re.I)
_STYLE_PATH = re.compile(r"\.(css|scss|sass|less|styl)$", re.I)
_UI_PATH = re.compile(
    r"\.(tsx|jsx|vue|svelte|html?|astro|xib|storyboard)$|(^|/)(components?|pages|views?|screens?|ui|layouts?|"
    r"templates|res/layout)(/|$)|(View|Screen|Controller)\.(swift|kt|java)$|Css\.ts$", re.I)
_AUTH_PATH = re.compile(r"(auth|login|logout|signin|signup|session|oauth|passw|permission|identity|guard|"
                        r"jwt|acl|rbac|credential|access[_-]?control|worker_auth)", re.I)
_SECRET_PATH = re.compile(r"(^|/)\.env(\.|$)|secret|\.pem$|\.p12$|\.key$|id_rsa|credentials?\.json|\.keystore$", re.I)
_SECRET_LINE = re.compile(
    r"AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|"
    r"\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|"
    r"(?i:\b[\w-]*(?:api[_-]?key|secret|password|passwd|token)[\w-]*\s*[:=]\s*['\"][^'\"\s]{8,}['\"])")

LARGE_DIFF_LINES = 1000
LARGE_DIFF_FILES = 30
MASS_DELETION_LINES = 300


def file_category(path: str) -> str:
    p = path or ""
    if _TEST_PATH.search(p):
        return "test"
    if _MIGRATION_PATH.search(p):
        return "migration"
    if _DEP_PATH.search(p):
        return "dependency"
    if _CI_PATH.search(p):
        return "ci"
    if _DOC_PATH.search(p):
        return "doc"
    if _STYLE_PATH.search(p) or _UI_PATH.search(p):
        return "ui"
    return "code"


_CATEGORY_WORDS = {
    "ui": ("UI file", "UI files"),
    "code": ("source file", "source files"),
    "test": ("test file", "test files"),
    "migration": ("migration", "migrations"),
    "doc": ("doc", "docs"),
    "dependency": ("dependency manifest", "dependency manifests"),
    "ci": ("CI/infra file", "CI/infra files"),
}


def is_ui_touching(files: list[dict]) -> bool:
    return any(file_category(f.get("path") or "") == "ui" for f in files)


def _added_lines(patch: str) -> Iterable[tuple[str, str]]:
    """(path, line) for every added line of a unified patch."""
    cur = None
    for line in (patch or "").splitlines():
        if line.startswith("+++ "):
            p = line[4:].split("\t", 1)[0].strip()
            cur = p[2:] if p.startswith(("a/", "b/")) else p
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield cur or "", line[1:]


def _top_dirs(paths: list[str], n: int = 3) -> list[str]:
    counts: dict[str, int] = {}
    for p in paths:
        parts = p.split("/")
        d = "/".join(parts[:-1][-2:]) if len(parts) > 1 else "(repo root)"
        counts[d] = counts.get(d, 0) + 1
    return [d for d, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def analyze_changes(files: list[dict], patch: str = "") -> dict:
    """{files, additions, deletions, categories:{cat:n}, summary:str, ui_touching, flags:[…]}.

    `files`: [{path, status (M/A/D/R/??), additions, deletions, binary?}]. `patch` (optional)
    is scanned for secret-looking ADDED lines; the secret itself is never echoed back."""
    files = [f for f in files if f.get("path")]
    adds = sum(int(f.get("additions") or 0) for f in files)
    dels = sum(int(f.get("deletions") or 0) for f in files)
    cats: dict[str, int] = {}
    for f in files:
        c = file_category(f["path"])
        cats[c] = cats.get(c, 0) + 1
    if not files:
        summary = "No file changes recorded."
    else:
        order = ["ui", "code", "test", "migration", "doc", "dependency", "ci"]
        parts = []
        for c in order:
            n = cats.get(c)
            if n:
                one, many = _CATEGORY_WORDS[c]
                parts.append(f"{n} {one if n == 1 else many}")
        created = sum(1 for f in files if f.get("status") in ("A", "??"))
        deleted = sum(1 for f in files if f.get("status") == "D")
        extra = []
        if created:
            extra.append(f"{created} new")
        if deleted:
            extra.append(f"{deleted} deleted")
        summary = (f"Changed {len(files)} file{'s' if len(files) != 1 else ''} (+{adds} −{dels}): "
                   + ", ".join(parts) + "." + (f" {', '.join(extra).capitalize()}." if extra else ""))
        dirs = _top_dirs([f["path"] for f in files])
        if dirs:
            summary += " Mostly in " + ", ".join(dirs) + "."

    flags: list[dict] = []

    def flag(kind: str, label: str, detail: str, paths: list[str], severity: str = "warn"):
        flags.append({"kind": kind, "label": label, "detail": detail, "severity": severity,
                      "files": paths[:5], "count": len(paths)})

    mig = [f["path"] for f in files if file_category(f["path"]) == "migration"]
    if mig:
        flag("migration", "Database migration", f"{len(mig)} migration file(s) — check it is additive and reversible.", mig)
    auth = [f["path"] for f in files if _AUTH_PATH.search(f["path"])]
    if auth:
        flag("auth", "Auth / permissions", f"{len(auth)} file(s) in authentication or access-control code.", auth)
    secret_paths = [f["path"] for f in files if _SECRET_PATH.search(f["path"])]
    secret_lines: dict[str, int] = {}
    for p, line in _added_lines(patch):
        if _SECRET_LINE.search(line):
            secret_lines[p] = secret_lines.get(p, 0) + 1
    if secret_paths or secret_lines:
        paths = list(dict.fromkeys(secret_paths + list(secret_lines)))
        n = sum(secret_lines.values())
        detail = (f"{n} added line(s) look like a credential" if n else "Secret-like file names") + \
                 " — make sure no real secret is committed."
        flag("secrets", "Possible secret", detail, paths, "danger")
    deleted = [f["path"] for f in files if f.get("status") == "D"]
    if deleted:
        flag("deletion", "Files deleted", f"{len(deleted)} file(s) removed.", deleted)
    elif dels >= MASS_DELETION_LINES and dels > adds:
        big = sorted(files, key=lambda f: -(int(f.get("deletions") or 0)))
        flag("deletion", "Large removal", f"{dels} lines removed (more than added).", [f["path"] for f in big])
    if adds + dels >= LARGE_DIFF_LINES or len(files) >= LARGE_DIFF_FILES:
        big = sorted(files, key=lambda f: -(int(f.get("additions") or 0) + int(f.get("deletions") or 0)))
        flag("large_diff", "Large change", f"{len(files)} files, {adds + dels} lines changed — review in parts.",
             [f["path"] for f in big])
    deps = [f["path"] for f in files if file_category(f["path"]) == "dependency"]
    if deps:
        flag("dependencies", "Dependencies changed", f"{len(deps)} dependency manifest(s) or lockfile(s).", deps)
    ci = [f["path"] for f in files if file_category(f["path"]) == "ci"]
    if ci:
        flag("ci", "CI / infrastructure", f"{len(ci)} CI, container or infra file(s).", ci)

    return {
        "files": len(files),
        "additions": adds,
        "deletions": dels,
        "categories": cats,
        "summary": summary,
        "ui_touching": any(file_category(f["path"]) == "ui" for f in files),
        "flags": flags,
    }


# ------------------------------------------------------------------ DoD checklist

_BULLET = re.compile(r"^\s*(?:[-*•+]|\d+[.)]|[a-z][.)])\s+", re.I)
_CHECKBOX = re.compile(r"^\s*\[[ xX✓]?\]\s*")
_STOP = set("""a an the and or of to in on for with without from by be is are was were it its this that these those as at
into onto all any each every no not must should shall will can may when then than so such via per also only just new
existing updated update add added adds make makes made ensure ensures ensured work works working done task tasks
""".split())


def split_dod(text: str) -> list[str]:
    """Definition-of-done text → items. Bullets / numbered lines / checkboxes each become an
    item; a single un-bulleted line is split on semicolons. Headings (`#`, trailing `:`) and
    blank lines are dropped."""
    raw = [l for l in (text or "").splitlines()]
    items: list[str] = []
    for line in raw:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        s = _BULLET.sub("", s)
        s = _CHECKBOX.sub("", s).strip()
        if not s:
            continue
        if s.endswith(":") and len(s) < 60 and not items:
            continue  # a lead-in like "Done when:"
        items.append(s)
    if len(items) == 1 and ";" in items[0]:
        items = [p.strip().rstrip(".") for p in items[0].split(";") if p.strip()]
    return items


def _keywords(text: str) -> set[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", (text or "").lower())
    return {w for w in words if w not in _STOP and len(w) >= 4}


_PATHLIKE = re.compile(r"`([^`]+)`|(?<![\w/])((?:[\w.-]+/)+[\w.-]+|[\w-]+\.(?:py|tsx?|jsx?|sql|md|css|scss|go|rs|swift|kt|java|rb|json|ya?ml|toml|html))(?![\w/])")
_TEST_ITEM = re.compile(r"\b(tests?|specs?|unit[- ]tests?|e2e|test suite|coverage|pytest|vitest|jest|ci)\b", re.I)
_TEST_WRITE = re.compile(r"\b(add(ed|s)?|write|written|new|cover(s|ed|age)?|include[sd]?)\b.*\b(tests?|specs?)\b|"
                         r"\b(tests?|specs?)\b.*\b(add(ed)?|written|for|cover(s|ing)?)\b", re.I)
_TEST_PASS = re.compile(r"\b(pass(es|ing)?|green|succeed|succeeds|no failures|all tests)\b", re.I)
_MIG_ITEM = re.compile(r"\bmigrations?\b|\bschema\b|\bcolumn\b|\btable\b", re.I)
_DOC_ITEM = re.compile(r"\b(readme|docs?|documentation|documented|changelog|runbook)\b", re.I)


def _test_evidence_line(tests: dict) -> str:
    parts = []
    for inv in tests.get("latest") or []:
        c = inv.get("counts")
        if c:
            seg = f"{inv['framework']}: {c['passed']} passed"
            if c.get("failed"):
                seg += f", {c['failed']} failed"
            if c.get("errors"):
                seg += f", {c['errors']} errors"
            if c.get("unit") != "tests":
                seg += f" ({c['unit']})"
        elif inv["outcome"] == "exit_ok":
            seg = f"{inv['framework']}: exit 0 (no summary line)"
        elif inv["outcome"] == "exit_failed":
            seg = f"{inv['framework']}: exit {inv.get('exit_code') if inv.get('exit_code') is not None else 'error'}"
        else:
            seg = f"{inv['framework']}: result not captured"
        parts.append(seg)
    return "; ".join(parts)


def _match_files(tokens: list[str], paths: list[str]) -> tuple[list[str], list[str]]:
    hit, miss = [], []
    for t in tokens:
        t = t.strip().strip("./")
        if not t:
            continue
        found = [p for p in paths if p == t or p.endswith("/" + t) or p.endswith(t)]
        (hit if found else miss).append(found[0] if found else t)
    return hit, miss


def _claim_sentences(claim_text: str) -> list[str]:
    out = []
    for sent in re.split(r"(?<=[.!?])\s+|\n+", claim_text or ""):
        s = sent.strip(" -*•\t")
        if len(s) >= 4:
            out.append(s)
    return out


def match_claims(items: list[str], claim_text: str) -> dict[int, str]:
    """{item index: the sentence of the agent's own report that talks about it}. Each sentence is
    attributed to at most ONE item and each item gets at most one sentence (best keyword overlap
    first; ≥2 shared keywords, or 1 when the item has a single keyword)."""
    sents = _claim_sentences(claim_text)
    if not sents:
        return {}
    skw = [_keywords(s) for s in sents]
    pairs = []
    for i, item in enumerate(items):
        kw = _keywords(item)
        if not kw:
            continue
        need = 1 if len(kw) == 1 else 2
        for j, k in enumerate(skw):
            n = len(kw & k)
            if n >= need:
                pairs.append((n / max(len(kw), 1), n, -j, i, j))
    pairs.sort(reverse=True)
    used_i, used_j, out = set(), set(), {}
    for _r, _n, _mj, i, j in pairs:
        if i in used_i or j in used_j:
            continue
        used_i.add(i)
        used_j.add(j)
        out[i] = sents[j][:280]
    return out


def assess_dod(items: list[str], *, tests: dict, changes: dict, changed_paths: list[str],
               claim_text: str = "", verdikt: dict | None = None) -> list[dict]:
    """Each DoD item → {index, text, status: proven|not_proven|needs_human, basis, evidence,
    related?, claim?, verdikt?}.

    Deterministic rules, strongest evidence first:
      1. A Verdikt verdict for the item (it was sent as a criterion): pass → proven, fail →
         not_proven, anything else → needs_human (with the verdict attached).
      2. Test items ("tests pass", "add tests for …"): passing suites → proven; failing →
         not_proven; no test command in the run output → not_proven (nothing to point at).
         "Add tests" also accepts changed test files.
      3. Items naming files/paths: every named file among the changed files → proven; a named
         file missing → not_proven.
      4. Migration / docs items: a changed migration / doc file → proven, else not_proven.
      5. Anything else → needs_human (a person must look), with related changed files listed
         as a hint when their names share keywords with the item.
    The agent's own words are attached as `claim` and never change the status."""
    out = []
    verdicts = (verdikt or {}).get("by_item") or {}
    test_paths = [p for p in changed_paths if file_category(p) == "test"]
    mig_paths = [p for p in changed_paths if file_category(p) == "migration"]
    doc_paths = [p for p in changed_paths if file_category(p) == "doc"]
    tstatus = tests.get("status")
    tline = _test_evidence_line(tests)
    claims = match_claims(items, claim_text)
    for i, text in enumerate(items):
        rec: dict[str, Any] = {"index": i, "text": text, "status": "needs_human", "basis": "none", "evidence": None}
        v = verdicts.get(i)
        path_tokens = [a or b for a, b in _PATHLIKE.findall(text)]
        path_tokens = [t for t in path_tokens if ("/" in t or "." in t) and " " not in t.strip()]
        if v is not None:
            rec["verdikt"] = v
            oc = v.get("outcome")
            label = f"Verdikt run {v.get('run_short') or ''}".strip()
            if oc == "pass":
                rec.update(status="proven", basis="verdikt", evidence=f"{label}: pass")
            elif oc in ("fail",):
                det = v.get("actual") or v.get("reason") or ""
                rec.update(status="not_proven", basis="verdikt",
                           evidence=f"{label}: fail" + (f" — {det[:160]}" if det else ""))
            elif oc == "warning":
                rec.update(status="needs_human", basis="verdikt", evidence=f"{label}: warning (non-critical failure)")
            else:
                rec.update(status="needs_human", basis="verdikt", evidence=f"{label}: {oc or 'no verdict'}")
        elif _TEST_ITEM.search(text) and (_TEST_PASS.search(text) or _TEST_WRITE.search(text)):
            wants_new = bool(_TEST_WRITE.search(text)) and not _TEST_PASS.search(text)
            if wants_new and test_paths:
                rec.update(status="proven", basis="changes",
                           evidence="Test files changed: " + ", ".join(test_paths[:3]) +
                           (f" (+{len(test_paths) - 3} more)" if len(test_paths) > 3 else ""))
                if tstatus == "failed":
                    rec.update(status="not_proven", basis="tests", evidence=tline + " — the run's tests are failing")
            elif tstatus == "passed" or tstatus == "exit_ok":
                rec.update(status="proven", basis="tests", evidence=tline)
                if wants_new and not test_paths:
                    rec.update(status="needs_human", evidence=tline + " — but no test file changed")
            elif tstatus == "failed":
                rec.update(status="not_proven", basis="tests", evidence=tline)
            elif tstatus == "unverified":
                rec.update(status="needs_human", basis="tests", evidence=tline or "tests ran; result not readable")
            else:
                rec.update(status="not_proven", basis="tests",
                           evidence="No test command found in this task's run output")
        elif path_tokens:
            hit, miss = _match_files(path_tokens, changed_paths)
            if hit and not miss:
                rec.update(status="proven", basis="changes", evidence="Changed: " + ", ".join(hit[:4]))
            elif miss:
                rec.update(status="not_proven", basis="changes",
                           evidence="Not among the changed files: " + ", ".join(miss[:4]))
        elif _MIG_ITEM.search(text) and re.search(r"\bmigrations?\b", text, re.I):
            if mig_paths:
                rec.update(status="proven", basis="changes", evidence="Migration changed: " + ", ".join(mig_paths[:3]))
            else:
                rec.update(status="not_proven", basis="changes", evidence="No migration file among the changes")
        elif _DOC_ITEM.search(text):
            if doc_paths:
                rec.update(status="proven", basis="changes", evidence="Docs changed: " + ", ".join(doc_paths[:3]))
            else:
                rec.update(status="not_proven", basis="changes", evidence="No documentation file among the changes")
        if rec["status"] == "needs_human" and rec["basis"] == "none":
            kw = _keywords(text)
            related = [p for p in changed_paths if kw & _keywords(re.sub(r"[/._-]", " ", p))]
            if related:
                rec["related"] = related[:4]
                rec["evidence"] = "Related changes: " + ", ".join(related[:3])
        if i in claims:
            rec["claim"] = claims[i]
        out.append(rec)
    return out


def dod_summary(items: list[dict]) -> dict:
    return {
        "total": len(items),
        "proven": sum(1 for i in items if i["status"] == "proven"),
        "not_proven": sum(1 for i in items if i["status"] == "not_proven"),
        "needs_human": sum(1 for i in items if i["status"] == "needs_human"),
    }


def summary_line(dod: dict, tests: dict, flags: list[dict], verdikt: dict | None = None) -> str:
    """"3/4 DoD items evidenced · 42 tests passed · 1 risk flag" — each part only when real."""
    parts = []
    if dod.get("total"):
        parts.append(f"{dod['proven']}/{dod['total']} DoD items evidenced")
    st = tests.get("status")
    if st == "none":
        parts.append("no tests ran")
    elif tests.get("failed") or tests.get("errors"):
        parts.append(f"{tests.get('failed', 0) + tests.get('errors', 0)} tests failing")
    elif tests.get("passed"):
        parts.append(f"{tests['passed']} tests passed")
    elif st == "exit_ok":
        parts.append("tests exited 0")
    elif st == "failed":
        parts.append("tests failing")
    elif st == "unverified":
        parts.append("tests ran (result unreadable)")
    if flags:
        parts.append(f"{len(flags)} risk flag{'s' if len(flags) != 1 else ''}")
    if verdikt and verdikt.get("status"):
        vs = verdikt["status"]
        if vs == "completed" and verdikt.get("verdict"):
            parts.append(f"Verdikt {verdikt['verdict']}")
        elif vs in ("queued", "running"):
            parts.append(f"Verdikt {vs}")
        else:
            parts.append(f"Verdikt {vs}")
    return " · ".join(parts)
