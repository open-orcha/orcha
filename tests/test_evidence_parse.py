"""Proof-of-work evidence — the pure parsers (portal_backend.evidence_parse).

No DB needed: stream-json command extraction (Claude + Codex), test detection + runner summary
parsing across frameworks (and NOT inventing counts), change summary + risk flags, DoD split +
deterministic assessment, and the one-line summary."""
import json

from portal_backend import evidence_parse as ep


def _claude(cmd, out, *, err=False, tid="t1"):
    use = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd}}]}}
    res = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tid, "content": out, "is_error": err}]}}
    return json.dumps(use) + "\n" + json.dumps(res)


# ------------------------------------------------------------------ extraction

def test_extracts_claude_bash_commands_with_output_and_exit():
    out = "\n".join([
        json.dumps({"type": "system", "subtype": "init"}),
        _claude("pytest -q", "41 passed in 0.52s", tid="a"),
        _claude("npm test", "Exit code 1\nTests:       1 failed, 9 passed, 10 total", err=True, tid="b"),
        "not json at all",
    ])
    cmds = ep.extract_commands(out)
    assert [c["command"] for c in cmds] == ["pytest -q", "npm test"]
    assert cmds[0]["exit_code"] == 0 and cmds[0]["is_error"] is False
    assert cmds[1]["exit_code"] == 1 and cmds[1]["is_error"] is True


def test_extracts_claude_tool_result_list_content():
    use = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "x", "name": "Bash", "input": {"command": "go test ./..."}}]}}
    res = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "x", "content": [{"type": "text", "text": "ok  \texample.com/a\t0.1s"}]}]}}
    cmds = ep.extract_commands(json.dumps(use) + "\n" + json.dumps(res))
    assert cmds[0]["output"].startswith("ok")


def test_extracts_codex_command_execution_items():
    started = {"type": "item.started", "item": {"id": "i1", "type": "command_execution",
                                                "command": ["bash", "-lc", "pytest"], "status": "in_progress"}}
    done = {"type": "item.completed", "item": {"id": "i1", "type": "command_execution",
                                               "command": ["bash", "-lc", "pytest"],
                                               "aggregated_output": "==== 3 passed in 0.1s ====", "exit_code": 0}}
    end = {"msg": {"type": "exec_command_end", "call_id": "c9", "command": ["bash", "-lc", "cargo test"],
                   "aggregated_output": "test result: ok. 5 passed; 0 failed; 0 ignored", "exit_code": 0}}
    cmds = ep.extract_commands("\n".join(json.dumps(x) for x in (started, done, end)))
    assert [c["command"] for c in cmds] == ["pytest", "cargo test"]
    assert cmds[0]["exit_code"] == 0 and "3 passed" in cmds[0]["output"]


def test_unanswered_tool_use_is_kept_without_result():
    use = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "z", "name": "Bash", "input": {"command": "pytest"}}]}}
    c = ep.extract_commands(json.dumps(use))[0]
    assert c["exit_code"] is None and c["output"] == ""


# ------------------------------------------------------------------ test detection

def test_framework_detection_only_counts_runner_heads():
    yes = {
        "pytest -q tests/": "pytest",
        "cd app && PYTHONPATH=. .venv/bin/python -m pytest -x": "pytest",
        "uv run pytest": "pytest",
        "timeout 120 npx vitest run": "vitest",
        "npm test": "npm test",
        "pnpm run test:unit": "pnpm test:unit",
        "yarn test": "yarn test",
        "go test ./...": "go test",
        "cargo test --all": "cargo test",
        "python3 -m unittest discover": "unittest",
        "xcodebuild -scheme App test": "xcodebuild test",
        "swift test": "swift test",
        "bundle exec rspec": "rspec",
        "./gradlew test": "gradle",
        "bash -lc 'npx jest --ci'": "jest",
        "npx playwright test": "playwright",
        "make test": "make test",
    }
    for cmd, fw in yes.items():
        assert ep.test_framework(cmd) == fw, cmd
    for cmd in ("grep -r pytest .", "cat tests/test_x.py", "ls tests", "echo npm test", "pip install pytest",
                "npx playwright install", "git commit -m 'run pytest'", "npm install"):
        assert ep.test_framework(cmd) is None, cmd


# ------------------------------------------------------------------ counts

def test_parses_runner_summaries():
    cases = {
        "==== 1 failed, 41 passed, 2 skipped in 3.21s ====": (41, 1, 2, 0),
        "41 passed, 3 warnings in 0.50s": (41, 0, 0, 0),
        "=== 2 passed, 1 error in 1.0s ===": (2, 0, 0, 1),
        " Test Files  2 passed (2)\n      Tests  1 failed | 41 passed | 2 skipped (44)": (41, 1, 2, 0),
        "      Tests  12 passed (12)": (12, 0, 0, 0),
        "Tests:       1 failed, 41 passed, 42 total": (41, 1, 0, 0),
        "Ran 12 tests in 0.010s\n\nFAILED (failures=1, errors=2)": (9, 1, 0, 2),
        "Ran 5 tests in 0.1s\n\nOK (skipped=1)": (4, 0, 1, 0),
        "  41 passing (2s)\n  1 failing": (41, 1, 0, 0),
        "Executed 42 tests, with 1 failure (0 unexpected) in 1.2 (1.3) seconds": (41, 1, 0, 0),
        "10 examples, 2 failures, 1 pending": (7, 2, 1, 0),
        "Passed!  - Failed:     0, Passed:    42, Skipped:     0, Total:    42": (42, 0, 0, 0),
        "OK (42 tests, 90 assertions)": (42, 0, 0, 0),
        "Tests run: 42, Failures: 1, Errors: 0, Skipped: 2": (39, 1, 2, 0),
        "test result: ok. 5 passed; 0 failed; 1 ignored\ntest result: FAILED. 3 passed; 2 failed; 0 ignored": (8, 2, 1, 0),
    }
    for text, (p, f, s, e) in cases.items():
        c = ep.parse_test_counts(text)
        assert c is not None, text
        assert (c["passed"], c["failed"], c["skipped"], c["errors"]) == (p, f, s, e), (text, c)


def test_go_counts_packages_not_tests():
    c = ep.parse_test_counts("ok  \tgithub.com/x/a\t0.1s\nFAIL\tgithub.com/x/b\t0.2s\nFAIL\n")
    assert c["unit"] == "packages" and c["passed"] == 1 and c["failed"] == 1


def test_never_invents_counts():
    assert ep.parse_test_counts("") is None
    assert ep.parse_test_counts("collecting ... done\nall good!") is None
    assert ep.parse_test_counts("\x1b[32m3 passed\x1b[0m in 0.1s")["passed"] == 3  # ANSI stripped


def test_invocation_outcomes_and_latest_rerun_wins():
    cmds = [
        {"command": "pytest -q", "output": "1 failed, 9 passed in 1s", "exit_code": 1, "is_error": True, "index": 0},
        {"command": "ls", "output": "", "exit_code": 0, "index": 1},
        {"command": "pytest  -q", "output": "10 passed in 1s", "exit_code": 0, "is_error": False, "index": 2},
        {"command": "npm test", "output": "done", "exit_code": 0, "index": 3},
        {"command": "make test", "output": "", "exit_code": None, "is_error": None, "index": 4},
    ]
    inv = ep.test_invocations(cmds, run_id="r1")
    assert [i["outcome"] for i in inv] == ["failed", "passed", "exit_ok", "unknown"]
    s = ep.summarize_tests(inv)
    assert s["passed"] == 10 and s["failed"] == 0 and s["earlier"] == 1 and s["suites"] == 3
    assert s["status"] == "passed"


def test_summary_status_none_and_failed():
    assert ep.summarize_tests([])["status"] == "none"
    inv = ep.test_invocations([{"command": "pytest", "output": "", "exit_code": 2, "is_error": True}])
    assert ep.summarize_tests(inv)["status"] == "failed"
    inv = ep.test_invocations([{"command": "pytest", "output": "", "exit_code": None}])
    assert ep.summarize_tests(inv)["status"] == "unverified"


# ------------------------------------------------------------------ changes

def test_change_summary_and_risk_flags():
    files = [
        {"path": "web/src/pages/Login.tsx", "status": "M", "additions": 40, "deletions": 5},
        {"path": "api/auth/session.py", "status": "M", "additions": 10, "deletions": 2},
        {"path": "migrations/051_add_col.sql", "status": "A", "additions": 3, "deletions": 0},
        {"path": "tests/test_login.py", "status": "A", "additions": 30, "deletions": 0},
        {"path": "old/legacy.py", "status": "D", "additions": 0, "deletions": 120},
        {"path": "package.json", "status": "M", "additions": 1, "deletions": 1},
        {"path": ".github/workflows/ci.yml", "status": "M", "additions": 2, "deletions": 0},
        {"path": ".env.production", "status": "A", "additions": 1, "deletions": 0},
    ]
    patch = "+++ b/api/auth/session.py\n+API_KEY = 'abcd1234efgh5678'\n+normal = 1\n"
    a = ep.analyze_changes(files, patch)
    assert a["files"] == 8 and a["additions"] == 87 and a["deletions"] == 128
    assert a["summary"].startswith("Changed 8 files (+87 −128): 1 UI file")
    assert "1 migration" in a["summary"] and "1 test file" in a["summary"] and "deleted" in a["summary"]
    kinds = {f["kind"] for f in a["flags"]}
    assert kinds == {"migration", "auth", "secrets", "deletion", "dependencies", "ci"}
    sec = next(f for f in a["flags"] if f["kind"] == "secrets")
    assert "abcd1234" not in json.dumps(sec)  # the secret itself is never echoed
    assert set(sec["files"]) == {".env.production", "api/auth/session.py"}
    assert a["ui_touching"] is True


def test_large_diff_and_no_changes():
    files = [{"path": f"src/m{i}.py", "status": "M", "additions": 40, "deletions": 0} for i in range(30)]
    a = ep.analyze_changes(files)
    assert any(f["kind"] == "large_diff" for f in a["flags"]) and a["ui_touching"] is False
    empty = ep.analyze_changes([])
    assert empty["summary"] == "No file changes recorded." and empty["flags"] == []


# ------------------------------------------------------------------ DoD

def test_split_dod_forms():
    assert ep.split_dod("- a\n- b\n* c\n1. d\n- [ ] e\n- [x] f") == ["a", "b", "c", "d", "e", "f"]
    assert ep.split_dod("Tests pass; README updated.") == ["Tests pass", "README updated"]
    assert ep.split_dod("Done when:\n- one\n\n## heading\n- two") == ["one", "two"]
    assert ep.split_dod("") == []


def _tests(status, passed=0, failed=0):
    inv = [{"framework": "pytest", "command": "pytest", "exit_code": 0 if not failed else 1,
            "counts": {"passed": passed, "failed": failed, "skipped": 0, "errors": 0, "total": passed + failed, "unit": "tests"},
            "outcome": "failed" if failed else "passed", "run_id": "r"}] if status != "none" else []
    return {"status": status, "passed": passed, "failed": failed, "skipped": 0, "errors": 0, "latest": inv}


def test_assess_dod_rules():
    items = [
        "All tests pass",
        "Add tests for the login form",
        "`web/src/pages/Login.tsx` shows an error on bad password",
        "Add a migration for the sessions table",
        "README documents the flag",
        "The login button is blue",
        "`api/missing.py` is removed",
    ]
    paths = ["web/src/pages/Login.tsx", "tests/test_login.py", "migrations/051_sessions.sql"]
    out = ep.assess_dod(items, tests=_tests("passed", 42), changes={}, changed_paths=paths,
                        claim_text="I made the login button blue and wired the error. All tests pass.")
    st = [o["status"] for o in out]
    assert st == ["proven", "proven", "proven", "proven", "not_proven", "needs_human", "not_proven"]
    assert out[0]["evidence"] == "pytest: 42 passed"
    assert "tests/test_login.py" in out[1]["evidence"]
    assert out[5]["claim"].startswith("I made the login button blue")  # labelled claim, status unchanged
    assert out[5]["evidence"].startswith("Related changes: web/src/pages/Login.tsx")


def test_assess_dod_failing_and_missing_tests():
    fail = ep.assess_dod(["Tests pass"], tests=_tests("failed", 9, 1), changes={}, changed_paths=[])
    assert fail[0]["status"] == "not_proven" and "1 failed" in fail[0]["evidence"]
    none = ep.assess_dod(["Tests pass"], tests=_tests("none"), changes={}, changed_paths=[])
    assert none[0]["status"] == "not_proven" and "No test command" in none[0]["evidence"]


def test_assess_dod_verdikt_verdicts_win():
    v = {"by_item": {0: {"outcome": "pass", "run_short": "abcd1234"},
                     1: {"outcome": "fail", "actual": "button is red", "run_short": "abcd1234"},
                     2: {"outcome": "blocked", "run_short": "abcd1234"}}}
    out = ep.assess_dod(["Login works", "Button is blue", "Dark mode works"], tests=_tests("none"),
                        changes={}, changed_paths=[], verdikt=v)
    assert [o["status"] for o in out] == ["proven", "not_proven", "needs_human"]
    assert out[1]["evidence"] == "Verdikt run abcd1234: fail — button is red"


def test_summary_line():
    dod = {"total": 4, "proven": 3}
    assert ep.summary_line(dod, {"status": "passed", "passed": 42}, [{"kind": "auth"}]) == \
        "3/4 DoD items evidenced · 42 tests passed · 1 risk flag"
    assert ep.summary_line({"total": 0}, {"status": "none"}, []) == "no tests ran"
    assert ep.summary_line(dod, {"status": "failed", "failed": 2, "errors": 1}, [], {"status": "completed", "verdict": "fail"}) == \
        "3/4 DoD items evidenced · 3 tests failing · Verdikt fail"
    assert "Verdikt unavailable" in ep.summary_line(dod, {"status": "none"}, [], {"status": "unavailable"})


def test_claims_are_attributed_one_to_one():
    items = ["All tests pass", "Add a unit test for the wrong-password path",
             'Entering a wrong password shows "Wrong password"', "After signing in the page greets the user by name"]
    report = ("Added a red 'Wrong password' message and a unit test for the wrong-password path. "
              "All tests pass (87 web + 40 API). Signing in now greets the user by name.")
    m = ep.match_claims(items, report)
    assert m[0].startswith("All tests pass")
    assert m[1].startswith("Added a red")
    assert m[3].startswith("Signing in now greets")
    assert 2 not in m  # the sentence is already the best match for item 1 — never shown twice
    assert ep.match_claims(items, "") == {}
