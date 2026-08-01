/* ============================================================================
   "Load error … → 502" toast noise (fix/web-chat-send-ux) — during a portal
   restart the 3s snapshot poll 502s tick after tick; data.js used to toast on
   EVERY failed tick, spraying transient "Load error" toasts over the page.

   Pins the damped behavior in the REAL data.js:
     - the FIRST consecutive failure retries silently (a transient blip
       self-heals on the next tick, no toast);
     - a persistent outage toasts exactly ONCE (no stacking repeats per tick);
     - a successful refresh re-arms both, so the NEXT outage again gets its
       silent retry + single toast.

   Dependency-free (mirrors the other tests/portal suites): real data.js in a
   vm sandbox; setInterval is captured so the test drives the tick cadence.

   Run: node tests/portal/load_error_toast.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DATA_JS = fs.readFileSync(path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "data.js"
), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((r) => setImmediate(r));
async function drain() { for (let i = 0; i < 10; i++) await flush(); }

/* ---- sandbox: fetch flips between healthy and 502, tick is hand-driven ---- */
const NETSTATE = { down: false };
const toasts = [];
function fakeFetch(url) {
  const u = String(url);
  if (NETSTATE.down) return Promise.resolve({ ok: false, status: 502 });
  if (/\/api\/containers$/.test(u))
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { containers: [{ id: "c1", status: "active" }] }) });
  if (/\/api\/containers\/c1$/.test(u))
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { container: { id: "c1", name: "P", status: "active" }, agents: [], tasks: [], requests: [] }) });
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
}
const captured = { tick: null };
const sandbox = {
  window: {
    Orcha: {
      toast: (msg, kind) => toasts.push({ msg, kind }),
      applySnapshot: (s) => (sandbox.window.ORCHA = s),
    },
  },
  console, fetch: fakeFetch, URLSearchParams,
  setInterval: (fn) => { captured.tick = fn; return 1; },
  clearInterval() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });

(async () => {
  console.log("\nload-error toast damping (data.js poll)\n");

  // boot healthy: the immediate first tick succeeds, no toast
  vm.runInContext("window.OrchaData.start(null, 3000)", sandbox);
  await drain();
  assert(toasts.length === 0, "a healthy boot tick never toasts");
  assert(typeof captured.tick === "function", "the 3s tick was scheduled (captured for hand-driving)");

  // portal restarts → 502s. First failed tick: SILENT retry.
  NETSTATE.down = true;
  captured.tick(); await drain();
  assert(toasts.length === 0, "the FIRST consecutive failure retries silently (transient blip → no toast)");

  // still down on the next tick → exactly one toast
  captured.tick(); await drain();
  assert(toasts.length === 1, "a persistent outage toasts ONCE (on the second consecutive failure)");
  assert(/^Load error: /.test(toasts[0].msg) && toasts[0].msg.indexOf("502") >= 0 && toasts[0].kind === "danger",
    "…and it is the danger 'Load error … 502' toast");

  // the outage drags on: the poll keeps hammering, the toast must NOT stack
  captured.tick(); captured.tick(); captured.tick(); await drain();
  assert(toasts.length === 1, "further failed ticks do NOT repeat the toast (one instance per outage)");

  // portal comes back → success resets the damper silently
  NETSTATE.down = false;
  captured.tick(); await drain();
  assert(toasts.length === 1, "recovery is silent (no success spam)");
  assert(sandbox.window.ORCHA && sandbox.window.ORCHA.container && sandbox.window.ORCHA.container.id === "c1",
    "…and the snapshot actually refreshed");

  // a NEW outage later gets the same treatment: silent first, one toast after
  NETSTATE.down = true;
  captured.tick(); await drain();
  assert(toasts.length === 1, "the next outage's first failure is silent again (damper re-armed)");
  captured.tick(); captured.tick(); await drain();
  assert(toasts.length === 2, "…then toasts exactly once more");

  console.log("");
  if (failures) { console.error(failures + " FAILURE(S)"); process.exit(1); }
  console.log("ALL PASS");
})().catch((e) => { console.error("HARNESS ERROR", (e && e.stack) || e); process.exit(2); });
