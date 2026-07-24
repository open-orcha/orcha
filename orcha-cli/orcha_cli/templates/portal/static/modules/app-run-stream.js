/* Orcha shared portal module: EventSource streaming, finished-log painting, and stop-run actions. */

// ---- REAL live stream: one EventSource per running run (folds in the SSE
// client). {seq,line} → classify + append; terminal {done,status} closes;
// stream_timeout reopens (30-min server cap); monotonic seq drops replay.
function startRunStream(logEl, agentId, runId) {
  if (typeof EventSource === "undefined") return () => {};
  let es = null, maxSeq = 0, stopped = false;
  function open() {
    if (stopped) return;
    try { es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(runId) + "/stream"); }
    catch (e) { return; }
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d && d.done) {
        if (es) { try { es.close(); } catch (e) {} es = null; }
        if (d.status === "stream_timeout" && !stopped) { open(); return; }  // reconnectable
        appendLine(logEl, { type: "done", label: "run-complete", text: String(d.status || "ended") });
        return;
      }
      if (d && typeof d.seq === "number" && typeof d.line === "string") {
        if (d.seq <= maxSeq) return;            // monotonic — drops reconnect replay
        maxSeq = d.seq;
        classifyLine(d.line).forEach((e) => appendLine(logEl, e));
      }
    };
  }
  open();
  return () => { stopped = true; if (es) { try { es.close(); } catch (e) {} es = null; } };
}

// synthesize a classified log for a FINISHED run from its captured output.
function paintFinished(logEl, run) {
  const output = run.output || "";
  if (!output.trim()) { appendLine(logEl, { type: "narrate", label: "log", text: "(no captured output)" }); }
  else output.split("\n").forEach((line) => { if (line.trim()) classifyLine(line).forEach((e) => appendLine(logEl, e)); });
  appendLine(logEl, { type: "done", label: "run-complete",
    text: (run.status || "ended") + (run.exit_code != null ? " · exit " + run.exit_code : "") });
}

// render a run card (header + chips + diff + log). live runs stream.
const TYPE_SW = { boot: "var(--ok)", narrate: "var(--text)", think: "var(--idle)", tool: "var(--info)",
  result: "var(--muted)", subagent: "var(--violet)", decision: "var(--amber)", error: "var(--danger)", done: "var(--ok)" };
const TYPE_LABEL = { boot: "lifecycle", narrate: "narration", think: "thinking", tool: "tool call",
  result: "tool result", subagent: "sub-agent", decision: "decision", error: "error", done: "complete" };
/* ---- SPEC-2 T2: graceful Stop of a single worker run ----------------- */
// run_ids a human has requested a stop for THIS session. Keeps the 'Stop requested'
// relabel sticky: the /runs poll early-returns on unchanged status, and even a forced
// repaint re-renders the button from this set — so it never reverts to active 'Stop run'
// until the run's status actually flips (then `live` is false and the button is gone).
const stopRequestedRuns = new Set();
function killCause(kr) { try { return (JSON.parse(kr) || {}).cause || ""; } catch (e) { return ""; } }
function stopRun(rid) {
  if (!rid) return;
  const h = actingHuman();
  if (!h) { toast("Pick an acting human first.", "danger"); return; }   // human-gated (POST /stop 403s non-humans)
  if (stopRequestedRuns.has(rid)) { toast("Stop already requested for this run.", "warn"); return; }
  modal({
    title: "Stop run " + shortId(rid) + "?",
    // Honesty (graceful stop): the API only RECORDS the intent; the host daemon reaps the
    // worker on its next wake-renew tick — it is NOT an instant kill.
    desc: "Requests a graceful stop — the worker halts at its next checkpoint (the daemon "
      + "reaps it on the next wake-tick, not instantly). The task stays in_progress for you "
      + "to reassign or rewake.",
    danger: true, primary: "Stop run",
    onPrimary: () => {
      closeModal();
      fetch("/api/runs/" + encodeURIComponent(rid) + "/stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_agent_id: h.id }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => {
          // Three 200 shapes from POST /api/runs/{id}/stop (main.py:3259 on overnight_612):
          //   already_finished → nothing live to signal; just report the terminal state.
          //   already_requested → a prior stop is already pending (still mark + relabel).
          //   fresh stop → stop_requested recorded.
          if (d && d.already_finished) { toast("Run already " + (d.status || "finished") + ".", "warn"); return; }
          markStopRequested(rid);
          toast(d && d.already_requested ? "Stop already requested." : "Stop requested — the worker halts on the next tick.", "ok");
        })
        .catch((e) => toast("Stop failed (" + e + ").", "danger"));
    },
  });
}
function markStopRequested(rid) {
  stopRequestedRuns.add(rid);
  // Instant feedback: relabel the live button now (the next /runs poll early-returns on
  // unchanged status, so it would otherwise stay 'Stop run' until the status flips).
  try {
    const sel = '[data-run-stop="' + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(rid) : rid) + '"]';
    const btns = document.querySelectorAll(sel) || [];
    btns.forEach((b) => {
      b.disabled = true;
      b.title = "Stop requested — the worker halts at its next checkpoint";
      b.innerHTML = '<span class="sq"></span>Stop requested';
    });
  } catch (e) {}
}
function onRunStopClick(ev) {
  const t = ev && ev.target;
  const b = t && t.closest && t.closest("[data-run-stop]");
  if (!b || b.disabled) return;
  stopRun(b.getAttribute("data-run-stop"));
}
function runCard(run) {
  const rid = run.run_id || run.id;
  const live = run.status === "running";
  const statusTxt = live ? "running" : run.status;
  const started = run.started_at || run.started;
  const ended = run.ended_at || run.ended;
  const killed = run.status === "killed";
  // #299 honesty: a human-stopped run ALSO reaps as status='killed' (kill_reason.cause=
  // 'human_stop'); only a watchdog stall/cap kill should read 'watchdog-killed'.
  const killTag = killed ? (killCause(run.kill_reason) === "human_stop" ? " ■ stopped" : " ⚠ watchdog-killed") : "";
  const stopReq = stopRequestedRuns.has(rid);
  const stopBtn = live
    ? `<button class="btn sm stop" type="button" data-run-stop="${esc(rid)}"${stopReq ? " disabled" : ""} title="${stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run"}"><span class="sq"></span>${stopReq ? "Stop requested" : "Stop run"}</button>`
    : "";
  return `<div class="run">
    <div class="run-h">
      <span class="rstat ${esc(statusTxt)}">${esc(statusTxt)}${run.exit_code != null && !live ? " · exit " + run.exit_code : ""}${killTag}</span>
      <span class="tag mono">${esc(run.wake_kind === "tmux" ? "live tab" : (run.wake_kind || ""))}</span>
      ${live ? '<span class="live accent"><span class="d"></span>live</span>' : ""}
      ${stopBtn}
      <span class="when">${esc(clockTime(started))}${ended ? " → " + esc(clockTime(ended)) : " …"}${started ? ' · ' + esc(relTime(ended || started)) : ""}</span>
    </div>
    ${run.diff != null ? `<details><summary style="cursor:pointer;color:var(--info);font-size:12.5px;padding:0 15px 10px;font-weight:600">code diff</summary><div style="padding:0 15px 14px">${renderDiff(run.diff)}</div></details>` : ""}
    <details open>
      <summary style="cursor:pointer;color:var(--muted);font-size:12.5px;padding:8px 15px;font-weight:600;border-top:1px solid var(--border)">log${live ? " · streaming" : ""}</summary>
      <div class="log" id="run-${esc(rid)}"></div>
    </details>
  </div>`;
}
// call AFTER runCards are in the DOM to start streams / paint static logs.
function activateRuns(runs) {
  const stops = [];
  (runs || []).forEach((run) => {
    const rid = run.run_id || run.id;
    const logEl = document.getElementById("run-" + rid);
    if (!logEl) return;
    wireSections(logEl);
    if (run.status === "running" && (run.agent_id || run.agent)) {
      stops.push(startRunStream(logEl, run.agent_id || run.agent, rid));
    } else {
      paintFinished(logEl, run);
    }
  });
  return () => stops.forEach((s) => s());
}

/* ---- apply the persisted/default theme + sync label on load ---------- */
// P2: set <html data-theme> immediately at load so a saved 'light' (or 'auto' on a
// light OS) doesn't flash the dark :root default until the user clicks the toggle.
// setAttribute (not applyTheme) so a default 'auto' stays implicit — not persisted.
document.documentElement.setAttribute("data-theme", currentTheme());
document.addEventListener("DOMContentLoaded", syncThemeLabel);
// SPEC-2 T2: one delegated listener covers every runCard on every page — the run feed is
// repainted each poll, but `document` persists, so a single handler outlives the repaints.
