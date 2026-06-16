/* ============================================================================
   ISS-84 / #244 — preflight error prompts (Glass, portal frontend).
   Dependency-free node/vm harness (the repo has ZERO js test infra; tests/ is
   otherwise pytest). Run: `node tests/portal/preflight.test.js` (exit 0 = pass).

   Covers the contract-first frontend Glass built to Helm's signed-off contract:
     PART A  OrchaTerm.preflight(aid) — the deterministic readiness probe that
             asks the bridge whether the runtime CLI is installed. Real exported
             function: http-base derivation + FAIL-OPEN on every error path.
     PART B  conversation.js exitClass→corrective-prompt mapping + the ordering
             and HONESTY-GUARD invariants (the private onTermState/preflightFail
             logic is asserted structurally — it is not exported).
   Integration (live bridge round-trip) is verified once Anvil's bridge probe
   verb + typed exit frame land; this harness pins the frontend half.
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates", "portal", "static");
const TERMINAL_JS = fs.readFileSync(path.join(STATIC, "terminal.js"), "utf8");
const CONVO_JS = fs.readFileSync(path.join(STATIC, "conversation.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.error("  ✗ " + name); } }
async function asyncOk(name, fn) { try { ok(name, await fn()); } catch (e) { failed++; console.error("  ✗ " + name + " — threw: " + e.message); } }

/* ---- load terminal.js fresh per case so resolveBridgeBase's _baseCache resets ---- */
function loadTerm(fetchImpl) {
  const sandbox = {
    window: {}, console,
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    AbortController: function () { this.signal = {}; this.abort = function () {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TERMINAL_JS, sandbox, { filename: "terminal.js" });
  return sandbox.window.OrchaTerm;
}
// fetch stub: cfgWs = ws_url returned by /api/terminal/config; preflightHandler(url) handles the probe.
function makeFetch(cfgWs, preflightHandler) {
  return function (url) {
    if (String(url).indexOf("/api/terminal/config") !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(cfgWs ? { ws_url: cfgWs } : {}) });
    }
    return preflightHandler(String(url));
  };
}

(async function () {
  console.log("PART A — OrchaTerm.preflight (deterministic readiness probe)");

  // 1) ws:// base → http:// preflight URL, installed payload passes through verbatim.
  await asyncOk("ws:// base derives http:// probe URL and returns the parsed payload", async () => {
    let seen = null;
    const T = loadTerm(makeFetch("ws://127.0.0.1:8765", (url) => {
      seen = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ runtime: "claude", installed: true, exec_path: "/usr/bin/claude" }) });
    }));
    const pf = await T.preflight("agent-1");
    return seen === "http://127.0.0.1:8765/preflight?agent_id=agent-1" && pf && pf.installed === true && pf.runtime === "claude";
  });

  // 2) wss:// base → https:// (secure derivation).
  await asyncOk("wss:// base derives https:// probe URL", async () => {
    let seen = null;
    const T = loadTerm(makeFetch("wss://bridge.example:443/", (url) => { seen = url; return Promise.resolve({ ok: true, json: () => Promise.resolve({ installed: false }) }); }));
    await T.preflight("a2");
    return seen === "https://bridge.example:443/preflight?agent_id=a2";
  });

  // 3) installed:false is reported faithfully (caller gates on this).
  await asyncOk("installed:false flows through (the one pre-launch blocker)", async () => {
    const T = loadTerm(makeFetch("ws://127.0.0.1:8765", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ runtime: "codex", installed: false, install_hint: "Install Codex CLI…" }) })));
    const pf = await T.preflight("a3");
    return pf && pf.installed === false && pf.runtime === "codex";
  });

  // 4) FAIL-OPEN: non-2xx probe → null (never block pairing).
  await asyncOk("non-ok probe → null (fail-open)", async () => {
    const T = loadTerm(makeFetch("ws://127.0.0.1:8765", () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })));
    return (await T.preflight("a4")) === null;
  });

  // 5) FAIL-OPEN: network throw → null (bridge down / endpoint absent / older bridge).
  await asyncOk("probe throws → null (fail-open, ships ahead of Anvil's verb)", async () => {
    const T = loadTerm(makeFetch("ws://127.0.0.1:8765", () => Promise.reject(new Error("ECONNREFUSED"))));
    return (await T.preflight("a5")) === null;
  });

  // 6) FAIL-OPEN: even a broken /api/terminal/config still resolves (default base) and never throws.
  await asyncOk("config fetch error still resolves without throwing", async () => {
    const T = loadTerm(function (url) {
      if (String(url).indexOf("/api/terminal/config") !== -1) return Promise.reject(new Error("down"));
      return Promise.reject(new Error("down"));
    });
    return (await T.preflight("a6")) === null;
  });

  console.log("PART B — conversation.js exitClass mapping + invariants (structural)");

  // 7) The exitClass branch MUST precede the generic "bridge not reachable" bucket, else every
  //    typed CLI-exit silently falls through to the wrong copy. This is the core ordering property.
  ok("exitClass branch is placed BEFORE the generic 'not reachable' bucket", (() => {
    const iExit = CONVO_JS.indexOf("info.exitClass) { preflightFail(info)");
    const iGeneric = CONVO_JS.indexOf("Terminal bridge not reachable");
    return iExit !== -1 && iGeneric !== -1 && iExit < iGeneric;
  })());

  // 8) preflightFail handles all three named classes + a default.
  ok("preflightFail switches on not_installed / auth_required / usage_limit", (
    CONVO_JS.indexOf('case "not_installed"') !== -1 &&
    CONVO_JS.indexOf('case "auth_required"') !== -1 &&
    CONVO_JS.indexOf('case "usage_limit"') !== -1
  ));

  // 9) HONESTY GUARD (Helm sign-off, non-negotiable): the default/unknown branch renders a neutral
  //    "see the terminal output" prompt — it must NOT fabricate a cause (no invented balance/auth).
  ok("unknown class degrades to a neutral 'see the terminal output' prompt", (() => {
    const m = CONVO_JS.match(/default:[\s\S]*?see the terminal output above/);
    return !!m;
  })());

  // 10) gateThenPair FAILS OPEN: it blocks only on installed===false; a null probe → openPair.
  ok("gateThenPair blocks only on installed===false (fail-open otherwise)", (
    CONVO_JS.indexOf("pf && pf.installed === false") !== -1 &&
    CONVO_JS.indexOf("}).catch(function () { openPair(preempt); })") !== -1
  ));

  // 11) Re-attach skips the pre-gate (the session is already live — nothing to pre-check).
  ok("gateThenPair skips the probe on re-attach", CONVO_JS.indexOf("if (reattach ||") !== -1);

  // 12) Install copy mirrors the canonical CLI hint strings (__main__.py:1695-1697) for both runtimes.
  ok("install hints mirror the canonical ORCHA_CLAUDE_EXEC / ORCHA_CODEX_EXEC strings", (
    CONVO_JS.indexOf("Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.") !== -1 &&
    CONVO_JS.indexOf("Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex.") !== -1
  ));

  console.log("\n" + (failed === 0 ? "ALL PASS" : "FAILURES") + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
