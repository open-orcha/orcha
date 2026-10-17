"""Proof-of-work evidence — node's built-in test runner (node:test) and package-script tests.

Regression: `node --test` was not recognised as a test command, and node's TAP output
("ok 2 - top level ok" at column 0) was misparsed as `go test` package lines — a FAILING node
run was reported as "go: 1 ok, 0 FAIL" (passing). The samples below are real output captured
from node v20.20.2, v22.22.2 and v24.18.0 (paths shortened); the go sample is the standard
`go test ./...` format."""
import json

from portal_backend import evidence_parse as ep

# ------------------------------------------------------------------ real output samples

# node 20 / 22, default reporter when stdout is not a TTY (an agent's Bash tool) = TAP
NODE22_TAP_FAILING = """TAP version 13
# Subtest: cart
    # Subtest: adds items
    ok 1 - adds items
      ---
      duration_ms: 0.329167
      type: 'test'
      ...
    # Subtest: removes items
    not ok 2 - removes items
      ---
      duration_ms: 0.443625
      type: 'test'
      location: '/home/dev/wishlist-web/test/math.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 1
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/dev/wishlist-web/test/math.test.mjs:5:40)
        Test.runInAsyncScope (node:async_hooks:214:14)
        Test.run (node:internal/test_runner/test:1047:25)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
      ...
    # Subtest: skipped one
    ok 3 - skipped one # SKIP
      ---
      duration_ms: 0.104
      type: 'test'
      ...
    # Subtest: todo one
    ok 4 - todo one # TODO
      ---
      duration_ms: 0.621958
      type: 'test'
      ...
    1..4
not ok 1 - cart
  ---
  duration_ms: 2.133958
  type: 'suite'
  location: '/home/dev/wishlist-web/test/math.test.mjs:3:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top level ok
ok 2 - top level ok
  ---
  duration_ms: 0.065458
  type: 'test'
  ...
1..2
# tests 5
# suites 1
# pass 2
# fail 1
# cancelled 0
# skipped 1
# todo 1
# duration_ms 62.279
"""

# node 20 TAP (no `type:` keys in the YAML blocks), all passing, 35 tests
NODE20_TAP_PASSING = """TAP version 13
# Subtest: wishlist saves an item
ok 1 - wishlist saves an item
  ---
  duration_ms: 1.912
  ...
# Subtest: wishlist removes an item
ok 2 - wishlist removes an item
  ---
  duration_ms: 0.401
  ...
1..35
# tests 35
# suites 4
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 412.55
"""

# node 23+/24 default (and `--test-reporter=spec` on any version): spec reporter
NODE24_SPEC_FAILING = """▶ cart
  ✔ adds items (0.357125ms)
  ✖ removes items (0.521292ms)
  ﹣ skipped one (0.060917ms) # SKIP
  ✔ todo one (0.057333ms) # TODO
✖ cart (2.381375ms)
✔ top level ok (0.101083ms)
ℹ tests 5
ℹ suites 1
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 1
ℹ duration_ms 60.685417

✖ failing tests:

test at math.test.mjs:5:3
✖ removes items (0.521292ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (file:///home/dev/wishlist-web/test/math.test.mjs:5:40)
      at Test.runInAsyncScope (node:async_hooks:227:14)
"""

# the spec reporter on a TTY colours everything — ANSI must not hide the summary
NODE_SPEC_ANSI = ("\x1b[32m✔ saves (1ms)\x1b[39m\n\x1b[31m✖ removes (2ms)\x1b[39m\n"
                  "\x1b[34mℹ tests 35\x1b[39m\n\x1b[34mℹ suites 3\x1b[39m\n\x1b[34mℹ pass 34\x1b[39m\n"
                  "\x1b[34mℹ fail 1\x1b[39m\n\x1b[34mℹ cancelled 0\x1b[39m\n\x1b[34mℹ skipped 0\x1b[39m\n"
                  "\x1b[34mℹ todo 0\x1b[39m\n\x1b[34mℹ duration_ms 812.1\x1b[39m\n")

# `npm test` (script "node --test") on npm 10: the wrapper banner + npm's own error noise
NPM_WRAPPED_FAILING = """
> wishlist-web@1.0.0 test
> node --test

TAP version 13
# Subtest: wishlist saves an item
ok 1 - wishlist saves an item
  ---
  duration_ms: 1.2
  type: 'test'
  ...
# Subtest: wishlist shows the count
not ok 2 - wishlist shows the count
  ---
  duration_ms: 3.4
  type: 'test'
  location: '/app/test/wishlist.test.js:12:1'
  failureType: 'testCodeFailure'
  error: 'expected 3, got 2'
  code: 'ERR_ASSERTION'
  ...
1..35
# tests 35
# suites 0
# pass 34
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 220.1
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /app
npm error command failed
npm error command sh -c node --test
"""

# older npm (8/9) noise
NPM8_NOISE_TAIL = "npm ERR! Test failed.  See above for more details.\n"

# a test that timed out is reported as cancelled — it did not pass
NODE_CANCELLED = """# Subtest: slow sync
not ok 1 - slow sync
  ---
  duration_ms: 5001.2
  failureType: 'cancelledByParent'
  error: 'test timed out after 5000ms'
  ...
1..3
# tests 3
# suites 0
# pass 2
# fail 0
# cancelled 1
# skipped 0
# todo 0
# duration_ms 5012.9
"""

GO_SAMPLE = """--- FAIL: TestCartTotal (0.00s)
    cart_test.go:14: total = 9, want 10
FAIL
FAIL\texample.com/shop/cart\t0.187s
ok  \texample.com/shop/wishlist\t0.123s
ok  \texample.com/shop/api\t(cached)
ok  \texample.com/shop/store\t0.402s\tcoverage: 81.2% of statements
?   \texample.com/shop/cmd/server\t[no test files]
FAIL\texample.com/shop/billing [build failed]
FAIL
"""

GO_VERBOSE_PASSING = """=== RUN   TestWishlistAdd
--- PASS: TestWishlistAdd (0.00s)
=== RUN   TestWishlistRemove
--- PASS: TestWishlistRemove (0.00s)
PASS
ok  \texample.com/shop/wishlist\t0.211s
"""


def _counts(text):
    c = ep.parse_test_counts(text)
    assert c is not None, text[:200]
    return c


def _claude(cmd, out, *, exit_code, tid):
    use = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd}}]}}
    text = (f"Exit code {exit_code}\n" if exit_code else "") + out
    res = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": bool(exit_code)}]}}
    return json.dumps(use) + "\n" + json.dumps(res)


# ------------------------------------------------------------------ detection

def test_node_builtin_runner_and_package_scripts_are_test_commands():
    yes = {
        "node --test": "node --test",
        "node --test test/": "node --test",
        "node --test --test-reporter=spec": "node --test",
        "node --test-reporter=tap --test 'test/**/*.test.mjs'": "node --test",
        "node --import tsx --test src/cart.test.ts": "node --test",
        "NODE_ENV=test node --experimental-test-coverage --test": "node --test",
        "node test/wishlist.test.mjs": "node --test",
        "cd web && node --test 2>&1 | tail -20": "node --test",
        "node --run test": "node --run test",
        "npm test": "npm test",
        "npm t": "npm test",
        "npm run test": "npm test",
        "npm run-script test": "npm test",
        "npm test -- --test-reporter=spec": "npm test",
        "npm --prefix web test": "npm test",
        "npm -w packages/api test": "npm test",
        "pnpm test": "pnpm test",
        "pnpm -C web test": "pnpm test",
        "pnpm --filter api test": "pnpm test",
        "pnpm test:unit": "pnpm test:unit",
        "yarn test": "yarn test",
        "yarn --cwd web test": "yarn test",
        "yarn workspace web test": "yarn test",
        "yarn test:e2e": "yarn test:e2e",
        "bash -lc 'npm test'": "npm test",
    }
    for cmd, fw in yes.items():
        assert ep.test_framework(cmd) == fw, cmd
    for cmd in ("node server.js", "node -e 'console.log(1)'", "node --version", "node scripts/build.mjs",
                "npm install", "npm run build", "pnpm install --filter api", "yarn add -D vitest",
                "echo node --test", "grep -r 'node --test' .", "cat package.json"):
        assert ep.test_framework(cmd) is None, cmd


# ------------------------------------------------------------------ counts

def test_node22_default_tap_failing_run_is_failing_with_counts():
    c = _counts(NODE22_TAP_FAILING)
    assert c["unit"] == "tests" and c["runner"] == "node:test"
    assert (c["passed"], c["failed"], c["skipped"], c["errors"], c["total"]) == (2, 1, 2, 0, 5)
    assert "go" not in c["source"]


def test_node20_tap_passing():
    c = _counts(NODE20_TAP_PASSING)
    assert (c["passed"], c["failed"], c["skipped"], c["errors"], c["total"]) == (35, 0, 0, 0, 35)
    assert c["runner"] == "node:test"


def test_node_spec_reporter():
    c = _counts(NODE24_SPEC_FAILING)
    assert (c["passed"], c["failed"], c["skipped"], c["total"]) == (2, 1, 2, 5)
    assert c["source"].startswith("node:test: ℹ tests 5")
    c = _counts(NODE_SPEC_ANSI)
    assert (c["passed"], c["failed"], c["total"]) == (34, 1, 35)


def test_npm_wrapper_noise_does_not_change_counts():
    for text in (NPM_WRAPPED_FAILING, NPM_WRAPPED_FAILING + NPM8_NOISE_TAIL):
        c = _counts(text)
        assert (c["passed"], c["failed"], c["total"]) == (34, 1, 35), text[-200:]
        assert c["runner"] == "node:test"


def test_node_cancelled_tests_are_not_passes():
    c = _counts(NODE_CANCELLED)
    assert (c["passed"], c["failed"], c["errors"], c["total"]) == (2, 0, 1, 3)


def test_node_summaries_from_several_workspaces_are_summed_so_a_failure_is_not_hidden():
    two = NPM_WRAPPED_FAILING + "\n> api@1.0.0 test\n> node --test\n\n" + NODE20_TAP_PASSING
    c = _counts(two)
    assert (c["passed"], c["failed"], c["total"]) == (69, 1, 70)
    assert "2 summaries" in c["source"]


def test_go_heuristic_never_claims_node_output():
    # every TAP sample has "ok N - name" at column 0 — the old heuristic read those as go packages
    for text in (NODE22_TAP_FAILING, NODE20_TAP_PASSING, NPM_WRAPPED_FAILING):
        assert ep._go_counts(text) is None
    # TAP with no summary block at all: no counts rather than invented go packages
    bare = "TAP version 13\nok 1 - saves\nnot ok 2 - removes\nok 3 - lists\n1..3\n"
    assert ep.parse_test_counts(bare) is None


def test_go_sample_still_parses_as_go_packages():
    c = _counts(GO_SAMPLE)
    assert c["unit"] == "packages" and c["runner"] == "go"
    assert (c["passed"], c["failed"]) == (3, 2), c  # cart FAIL, billing [build failed]; 3 ok
    c = _counts(GO_VERBOSE_PASSING)
    assert (c["passed"], c["failed"], c["unit"]) == (1, 0, "packages")


# ------------------------------------------------------------------ end to end: run output → pack tests

def test_failing_node_run_in_an_agent_transcript_is_reported_failing():
    out = "\n".join([
        _claude("node --test", NODE22_TAP_FAILING, exit_code=1, tid="a"),
        _claude("npm test", NPM_WRAPPED_FAILING, exit_code=1, tid="b"),
    ])
    inv = ep.test_invocations(ep.extract_commands(out), run_id="r1")
    assert [i["framework"] for i in inv] == ["node --test", "npm test (node:test)"]
    assert all(i["outcome"] == "failed" for i in inv)
    assert inv[1]["runner"] == "node:test"
    s = ep.summarize_tests(inv)
    assert s["status"] == "failed"
    assert (s["passed"], s["failed"], s["skipped"]) == (36, 2, 2)
    line = ep.summary_line({"total": 0}, s, [])
    assert line == "2 tests failing"


def test_npm_test_stays_unknown_framework_until_output_reveals_it():
    out = "\n".join([
        _claude("npm test", "\n> app@1.0.0 test\n> ./scripts/test.sh\n\nall good\n", exit_code=0, tid="a"),
        _claude("pnpm test", " Test Files  3 passed (3)\n      Tests  12 passed (12)\n", exit_code=0, tid="b"),
    ])
    inv = ep.test_invocations(ep.extract_commands(out))
    assert inv[0]["framework"] == "npm test" and inv[0]["runner"] is None and inv[0]["outcome"] == "exit_ok"
    assert inv[1]["framework"] == "pnpm test (vitest)" and inv[1]["outcome"] == "passed"


def test_passing_node_run_proves_a_tests_pass_dod_line():
    out = _claude("node --test", NODE20_TAP_PASSING, exit_code=0, tid="a")
    tests = ep.summarize_tests(ep.test_invocations(ep.extract_commands(out)))
    items = ep.assess_dod(["All tests pass"], tests=tests, changes={}, changed_paths=[])
    assert items[0]["status"] == "proven"
    assert items[0]["evidence"] == "node --test: 35 passed"
