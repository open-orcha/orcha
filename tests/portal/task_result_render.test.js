/* ============================================================================
   open-orcha#209 — task results render as "[object Object]" when structured.

   tasks.result is JSONB, but /done (TaskDone.result) takes a required plain
   string — the SERVER wraps every completion in {"result": <text>,
   "by_agent_id": <uuid>} (task_done_routes.py) before writing tasks.result, and
   the task detail page (Result field + the verification-gate "Result claimed
   by" block) string-interpolated that envelope as-is. An agent completion
   showed the verifying human "[object Object]" on the exact surface used to
   decide verify/reject. Fix under test: resultText() in pages/tasks-detail.js
   normalizes every shape to text at BOTH render sites, and unwraps the known
   {result, by_agent_id} envelope explicitly — even when result is blank, so a
   blank agent result renders as the caller's "—" instead of dumping the
   envelope (including the agent's UUID) onto the human decision surface.

   Dependency-free: loads the REAL tasks-detail.js source, extracts resultText
   via a vm sandbox, and greps both render sites for the wrapper. No npm.

   Run:  node tests/portal/task_result_render.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORTAL = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli",
  "templates", "portal", "static");
const SRC = fs.readFileSync(path.join(PORTAL, "pages", "tasks-detail.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- extract the real resultText() ---- */
const m = SRC.match(/function resultText\([\s\S]*?\n\}/);
assert(!!m, "resultText() exists in tasks-detail.js (mutation: delete it → RED)");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0] + "; this.resultText = resultText;", sandbox);
const resultText = sandbox.resultText;

/* ---- shape matrix ---- */
assert(resultText("PR opened: https://x") === "PR opened: https://x",
  "string passes through untouched");
assert(resultText(null) === "" && resultText(undefined) === "",
  "null/undefined → empty (caller supplies the em-dash)");
assert(resultText({ result: "PR #203 opened" }) === "PR #203 opened",
  'field shape {"result": "..."} yields the inner text (the field-observed bug shape)');
assert(resultText({ summary: "did the thing" }) === "did the thing",
  "summary field honored");
assert(resultText({ result: "  " , text: "fallback wins" }) === "fallback wins",
  "blank conventional field skipped in favor of the next non-empty one");
assert(resultText({ message: "b", result: "a" }) === "a",
  "field precedence: result outranks message (mutation: swap the key order in "
  + "resultText() → this goes RED)");
/* F2: the known server envelope {result, by_agent_id} unwraps explicitly, even
   when result is blank — the gate must show "—" (via the caller's fallback),
   never the envelope itself (which would leak the agent's UUID). */
assert(resultText({ result: "PR #203 opened", by_agent_id: "0c87c35b-1cce-4d27-9890-514b6d1a4b7d" }) === "PR #203 opened",
  "envelope shape {result, by_agent_id} unwraps to the inner result");
assert(resultText({ result: "", by_agent_id: "0c87c35b-1cce-4d27-9890-514b6d1a4b7d" }) === "",
  'blank envelope result unwraps to "" (caller\'s || "—" applies), not the pretty-printed envelope');
assert(resultText({ result: "   ", by_agent_id: "0c87c35b-1cce-4d27-9890-514b6d1a4b7d" }) === "   ",
  "whitespace-only envelope result also unwraps rather than falling through to JSON.stringify");
assert(!resultText({ result: "", by_agent_id: "0c87c35b-1cce-4d27-9890-514b6d1a4b7d" }).includes("by_agent_id"),
  "blank envelope result never leaks the agent UUID to the verification gate");
const pretty = resultText({ pr: 203, files: ["a.md", "b.md"] });
assert(pretty.includes('"pr": 203') && pretty.includes('"a.md"'),
  "arbitrary object → pretty-printed JSON, keys and values readable");
assert(!String(resultText({})).includes("[object Object]") &&
       !String(resultText({ nested: { x: 1 } })).includes("[object Object]"),
  "no shape ever coerces to [object Object] (mutation: revert either render "
  + "site to raw t.result → the site-grep below goes RED)");
assert(resultText(42) === "42", "non-object primitives stringified");

/* ---- both render sites go through the wrapper ---- */
const resultField = SRC.match(/class="lbl">Result<\/div>[\s\S]{0,120}/);
assert(resultField && /resultText\(t\.result\)/.test(resultField[0]),
  "Result field renders resultText(t.result), not raw t.result");
const gate = SRC.match(/max-height:300px;overflow-y:auto[\s\S]{0,160}/);
assert(gate && /resultText\(t\.result\)/.test(gate[0]),
  "verification-gate claimed-result block renders resultText(t.result)");
assert(!/linkify\(t\.result\)/.test(SRC) && !/linkify\(isPlan[^)]*t\.result \|\| "—"/.test(SRC),
  "no render site passes t.result to linkify unwrapped");

process.exit(failures ? 1 : 0);
