/* ============================================================================
   SPEC-2 T2 — graceful "Stop run" control (#299). A run whose status is
   `running` gets a danger-ghost Stop button in the run-card header; clicking it
   confirms, then POSTs the human-gated graceful-stop intent to
   POST /api/runs/{run_id}/stop. The button relabels to "Stop requested" and
   STAYS relabeled across /runs poll repaints until the run's status flips.

   Dependency-free: stubs a minimal DOM + fetch, loads the REAL portal app.js in
   a vm sandbox, and drives the actual wired path (runCard render → stopRun →
   confirm modal → POST → relabel via the sticky stopRequestedRuns set). No npm.

   Run:  node tests/portal/stop_run.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "app.js"
);
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM ---------------------------------------------------------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", textContent: "", disabled: false, title: "",
    dataset: {}, onclick: null,
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, appendChild: () => {}, focus: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  ["__mc", "__mp"].forEach((id) => { reg[id] = makeNode(id); });

  const captured = { modalHandlers: [] };
  reg.__mp.addEventListener = (ev, fn) => { if (ev === "click") captured.modalHandlers.push(fn); };
  reg.__mc.addEventListener = () => {};

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const documentElement = { setAttribute: () => {}, getAttribute: () => null };
  const document = {
    documentElement, body: makeNode("body"),
    addEventListener: () => {},
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],   // markStopRequested's DOM relabel is exercised via runCard re-render instead
  };
  const fetchCalls = [];
  const window = { matchMedia: () => ({ matches: false }) };
  const stopResponse = opts.stopResponse || { run_id: "r1", stop_requested: true, status: "running" };
  const sandbox = {
    window, document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      if (opts.failFetch) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(stopResponse) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg, fetchCalls, captured };
}

const tick = () => new Promise((r) => setImmediate(r));
const human = { id: "h1", alias: "Kedar", kind: "human" };
function withHuman(s) {
  s.Orcha.applySnapshot({ container: { id: "c1" }, agents: [human], tasks: [], requests: [] });
}
function noHuman(s) {
  s.Orcha.applySnapshot({ container: { id: "c1" }, agents: [], tasks: [], requests: [] });
}

async function run() {
  console.log("stop_run.test.js — SPEC-2 T2 graceful Stop run (#299)\n");

  // --- Case 1: Stop button renders ONLY when the run is live (running) -------
  {
    console.log("Case 1: runCard shows an active Stop button only for a running run");
    const s = makeSandbox();
    const liveHtml = s.Orcha.runCard({ run_id: "r1", status: "running", started_at: "2026-06-13T20:00:00Z" });
    assert(/data-run-stop="r1"/.test(liveHtml), "running run carries [data-run-stop]");
    assert(/Stop run/.test(liveHtml) && !/disabled/.test(liveHtml), "label 'Stop run', enabled");
    assert(/class="btn sm stop"/.test(liveHtml), "uses the danger-ghost .btn.sm.stop treatment");
    const doneHtml = s.Orcha.runCard({ run_id: "r2", status: "exited", exit_code: 0 });
    assert(!/data-run-stop/.test(doneHtml), "finished run has NO Stop button (presence = haltable)");
  }

  // --- Case 2: gate — no acting human → no modal, no POST -------------------
  {
    console.log("\nCase 2: no acting human → toast gate, no confirm modal, no POST");
    const s = makeSandbox();
    noHuman(s);
    s.Orcha.stopRun("r1");
    assert(s.fetchCalls.length === 0, "no POST without an acting human");
    assert(!s.reg.__ov, "no confirm modal opened");
    assert(/Pick an acting human/.test(s.reg.__toast.textContent), "toast: pick an acting human first");
  }

  // --- Case 3: happy path — confirm → POST {actor_agent_id} → ok toast ------
  {
    console.log("\nCase 3: confirm → POST graceful-stop, correct URL + body, success toast");
    const s = makeSandbox();
    withHuman(s);
    s.Orcha.stopRun("r1");
    assert(s.fetchCalls.length === 0, "no POST before the user confirms");
    assert(/Stop run r1\?/.test(s.reg.__ov.innerHTML), "confirm modal titled 'Stop run r1?'");
    s.captured.modalHandlers.forEach((fn) => fn());   // click "Stop run"
    await tick();
    assert(s.fetchCalls.length === 1, "exactly one POST fired");
    assert(/\/api\/runs\/r1\/stop$/.test(s.fetchCalls[0].url), "POST hits /api/runs/r1/stop");
    assert(s.fetchCalls[0].body.actor_agent_id === "h1", "body carries actor_agent_id (the acting human)");
    assert(/Stop requested/.test(s.reg.__toast.textContent), "success toast: 'Stop requested …'");
  }

  // --- Case 4: HELM ASK — relabel survives a poll repaint (unchanged status) -
  {
    console.log("\nCase 4: after stop, the SAME running run re-renders as a disabled 'Stop requested'");
    const s = makeSandbox();
    withHuman(s);
    const before = s.Orcha.runCard({ run_id: "r1", status: "running" });
    assert(/Stop run/.test(before) && !/disabled/.test(before), "before: active 'Stop run'");
    s.Orcha.stopRun("r1");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    // simulate a /runs poll repaint that returns the SAME (still running) status
    const after = s.Orcha.runCard({ run_id: "r1", status: "running" });
    assert(/Stop requested/.test(after), "after: relabels to 'Stop requested' across the repaint");
    assert(/disabled/.test(after), "after: the relabeled button is disabled");
    // a DIFFERENT run is unaffected — the sticky set is per run_id
    const other = s.Orcha.runCard({ run_id: "r9", status: "running" });
    assert(/Stop run/.test(other) && !/disabled/.test(other), "a different live run still shows active 'Stop run'");
  }

  // --- Case 5: 200 already_requested branch → still relabels ----------------
  {
    console.log("\nCase 5: already_requested response → 'Stop already requested' toast + relabel");
    const s = makeSandbox({ stopResponse: { run_id: "r1", stop_requested: true, status: "running", already_requested: true } });
    withHuman(s);
    s.Orcha.stopRun("r1");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(/Stop already requested/.test(s.reg.__toast.textContent), "toast: stop already requested");
    assert(/Stop requested/.test(s.Orcha.runCard({ run_id: "r1", status: "running" })), "still relabels the button");
  }

  // --- Case 6: 200 already_finished branch → no relabel (nothing live) ------
  {
    console.log("\nCase 6: already_finished response → terminal toast, button NOT relabeled");
    const s = makeSandbox({ stopResponse: { run_id: "r1", stop_requested: false, status: "exited", already_finished: true } });
    withHuman(s);
    s.Orcha.stopRun("r1");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(/Run already exited/.test(s.reg.__toast.textContent), "toast reports the terminal status");
    const html = s.Orcha.runCard({ run_id: "r1", status: "running" });
    assert(/Stop run/.test(html) && !/Stop requested/.test(html), "not added to the sticky set (nothing was live to stop)");
  }

  // --- Case 7: failed POST → danger toast, no relabel -----------------------
  {
    console.log("\nCase 7: non-200 → danger toast, button stays actionable");
    const s = makeSandbox({ failFetch: true });
    withHuman(s);
    s.Orcha.stopRun("r1");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(/Stop failed/.test(s.reg.__toast.textContent), "toast: stop failed");
    assert(!/Stop requested/.test(s.Orcha.runCard({ run_id: "r1", status: "running" })), "no relabel on failure");
  }

  // --- Case 8: HONESTY — confirm copy matches graceful (deferred) reality ----
  {
    console.log("\nCase 8: confirm copy is honest about graceful/deferred stop (not instant kill)");
    const s = makeSandbox();
    withHuman(s);
    s.Orcha.stopRun("r1");
    const ov = s.reg.__ov.innerHTML;
    assert(/next checkpoint/.test(ov) && /not instantly/.test(ov), "copy says it halts at the next checkpoint, not instantly");
    assert(/stays in_progress/.test(ov), "copy: the task stays in_progress (reassign or rewake)");
    assert(!/terminated/.test(ov), "copy does NOT claim the worker is 'terminated' mid-task");
  }

  // --- Case 9: HONESTY — a human-stopped killed run isn't 'watchdog-killed' --
  {
    console.log("\nCase 9: killed run labels by cause — human_stop vs watchdog");
    const s = makeSandbox();
    const stopped = s.Orcha.runCard({ run_id: "r1", status: "killed", kill_reason: JSON.stringify({ cause: "human_stop", by: "Kedar" }) });
    assert(/■ stopped/.test(stopped) && !/watchdog-killed/.test(stopped), "human_stop → '■ stopped'");
    const watchdog = s.Orcha.runCard({ run_id: "r2", status: "killed", kill_reason: JSON.stringify({ cause: "stalled" }) });
    assert(/watchdog-killed/.test(watchdog), "stalled → '⚠ watchdog-killed' (unchanged)");
    const noReason = s.Orcha.runCard({ run_id: "r3", status: "killed" });
    assert(/watchdog-killed/.test(noReason), "missing kill_reason → defaults to 'watchdog-killed'");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
