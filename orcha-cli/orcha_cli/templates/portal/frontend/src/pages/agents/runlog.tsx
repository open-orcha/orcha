/**
 * Worker-run live feed — faithful port of the app.js run engine used by the
 * Agents page: classifyLine (+ the codex classifier), appendLine/wireSections,
 * startRunStream/paintFinished, renderDiff, runCard and the SPEC-2 T2 graceful
 * Stop. Log lines are appended imperatively into a ref'd .log element (exactly
 * the vanilla write path — every string is esc()'d first) so a live SSE stream
 * never fights the React render cycle. Emits the same class names styles.css
 * already styles.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { sendJSON } from "../../api/client";
import { Icon, useToast } from "../../components/ui";
import { Button, ConfirmDialog, StatusIcon } from "../../components/primitives";
import { WorkedFor, formatDuration, RelTime } from "../../components/primitives";
import { ChangesCard } from "../../components/primitives";
import { useLogFollow } from "../../hooks/useLogFollow";
import { runDuration, runEnded, runOutcome, runStarted } from "../activity/runModel";
import { RunLogView } from "../activity/RunLogView";
import "../activity/activity.css";
import "./runlog.css";
import { esc, shortId, relTime, clockTime } from "../../lib/format";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Run } from "../../types";
import { classifyLine, selfAction, type LogEvent } from "../../lib/classify";
import { nearBottom, pinToBottom } from "../../lib/logScroll";
import { FilesChanged, parseDiffFiles } from "../../components/FilesChanged";
import { runBlobSource } from "../../components/filePreview/sources";

// LogEvent comes from lib/classify; `sec` (section collapse) is a legacy
// vanilla affordance the shared classifier never emits.
type LogRow = LogEvent & { sec?: string };

/** Row body text: never echo the type label back ("TOOL RESULT tool result") —
 *  fall back to the detail's first line when the text only repeats the label. */
export function logRowText(e: Pick<LogEvent, "text" | "label" | "type" | "detail">): string {
  const norm = (x: string) => x.replace(/[\s_-]+/g, " ").trim().toLowerCase();
  const text = e.text || "";
  const label = String(e.label || e.type || "");
  if (norm(text) && norm(text) !== norm(label)) return text;
  const first = (e.detail || "").split("\n").find((l) => l.trim());
  return first ? first.trim() : text;
}
function logRow(e: LogRow, isNew: boolean): string {
  const t = e.type || "narrate";
  // V2: tool details are expandable (native <details>, so an expanded row stays
  // expanded while the stream appends below it — appends never touch old rows).
  // The expanded body is height-capped and carries a Copy action (onLogClick).
  const det = e.detail
    ? `<details class="det-x"><summary>Details</summary><span class="det-w"><span class="det">${esc(e.detail)}</span><button type="button" class="det-copy" data-copy>Copy</button></span></details>`
    : "";
  // calm log (review): a plain output line carries no "log" type label, and the
  // caret gutter marks ONLY the expandable (detail-bearing) lines.
  const plain = !e.label || e.label === "log";
  return `<div class="ln t-${t}${plain ? " is-plain" : ""}${isNew ? " new" : ""}"><span class="gut">${e.detail ? "›" : ""}</span><span class="ty">${plain ? "" : esc(e.label || t)}</span><span class="tx">${esc(logRowText(e))}${det}</span></div>`;
}
const CHEV = '<svg class="" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7.5 10 12l5-4.5"/></svg>';
export function appendLine(logEl: HTMLElement, e: LogRow): void {
  // read BEFORE insert; pinToBottom pins instantly, so a followed log reads
  // back exactly at the bottom here no matter how tall the last row was
  // (a smooth-animated pin would read mid-animation and kill the follow).
  const atBottom = nearBottom(logEl);
  if (e.sec != null) {
    logEl.insertAdjacentHTML("beforeend", `<div class="sec"><span class="chev">${CHEV}</span><span>${esc(e.sec)}</span></div>`);
  } else {
    logEl.insertAdjacentHTML("beforeend", logRow(e, true));
    const last = logEl.lastElementChild;
    setTimeout(() => last && last.classList.remove("new"), 360);
  }
  // cap length so a long live stream can't grow unbounded
  while (logEl.children.length > 400 && logEl.firstElementChild) logEl.removeChild(logEl.firstElementChild);
  if (atBottom) pinToBottom(logEl);
}
// delegated log clicks: a details "Copy" copies that row's detail text; clicking a
// .sec hides/shows lines until the next .sec (wireSections)
function onLogSectionClick(ev: React.MouseEvent<HTMLDivElement>) {
  const t = ev.target as Element;
  const copy = t.closest ? t.closest("[data-copy]") : null;
  if (copy) {
    const det = copy.parentElement?.querySelector(".det");
    const txt = det ? det.textContent || "" : "";
    try {
      void navigator.clipboard.writeText(txt).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
    } catch { /* clipboard unavailable */ }
    return;
  }
  const sec = t.closest ? t.closest(".sec") : null;
  const logEl = ev.currentTarget;
  if (!sec || !logEl.contains(sec)) return;
  sec.classList.toggle("collapsed");
  const hide = sec.classList.contains("collapsed");
  let n = sec.nextElementSibling;
  while (n && !n.classList.contains("sec")) {
    n.classList.toggle("hidden", hide);
    n = n.nextElementSibling;
  }
}

/* ---- REAL live stream: one EventSource per running run ------------------- */
// {seq,line} → classify + append; terminal {done,status} closes; stream_timeout
// reopens (30-min server cap); monotonic seq drops replay.
export function startRunStream(logEl: HTMLElement, agentId: string, runId: string, onFail?: () => void): () => void {
  if (typeof EventSource === "undefined") {
    onFail?.();
    return () => {};
  }
  let es: EventSource | null = null,
    maxSeq = 0,
    got = false,
    stopped = false;
  function open() {
    if (stopped) return;
    try {
      es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(runId) + "/stream");
    } catch {
      return;
    }
    // review: a stream that errors before its first line (endpoint gone, run
    // already reaped) must not leave "Waiting for output…" forever — hand over
    // to the caller's fallback (the captured output, or "Log unavailable").
    es.onerror = () => {
      if (stopped || got) return;
      stopped = true;
      if (es) {
        try { es.close(); } catch { /* already closed */ }
        es = null;
      }
      onFail?.();
    };
    es.onmessage = (ev) => {
      got = true;
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d && d.done) {
        if (es) {
          try { es.close(); } catch { /* already closed */ }
          es = null;
        }
        if (d.status === "stream_timeout" && !stopped) { open(); return; } // reconnectable
        appendLine(logEl, { type: "done", label: "run-complete", text: String(d.status || "ended") });
        return;
      }
      if (d && typeof d.seq === "number" && typeof d.line === "string") {
        if (d.seq <= maxSeq) return; // monotonic — drops reconnect replay
        maxSeq = d.seq;
        classifyLine(d.line).forEach((e) => appendLine(logEl, e));
      }
    };
  }
  open();
  return () => {
    stopped = true;
    if (es) {
      try { es.close(); } catch { /* already closed */ }
      es = null;
    }
  };
}

// synthesize a classified log for a FINISHED run from its captured output.
// No trailing "run-complete" row: the run header already states the outcome
// (review: the same status twice). The exit code rides only on a non-zero exit.
export function paintFinished(logEl: HTMLElement, run: Pick<Run, "output" | "status" | "exit_code">): void {
  const output = run.output || "";
  if (!output.trim()) {
    appendLine(logEl, { type: "narrate", label: "log", text: "(no captured output)" });
  } else {
    output.split("\n").forEach((line) => {
      if (line.trim()) classifyLine(line).forEach((e) => appendLine(logEl, e));
    });
  }
}

/**
 * V2 follow wrapper for the imperative logs: appendLine already follows only
 * while the reader is at the bottom; this adds the "Jump to latest" control
 * once they scroll away (a MutationObserver notices appends without React
 * re-rendering the log, so focus/selection/expanded details are untouched).
 */
function FollowLog({ logRef, children }: { logRef: React.MutableRefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  const follow = useLogFollow(logRef);
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof MutationObserver === "undefined") return;
    const el2 = el;
    const onScroll = () => follow.onScroll();
    el2.addEventListener("scroll", onScroll, { passive: true });
    const mo = new MutationObserver(() => follow.onContent());
    mo.observe(el2, { childList: true });
    return () => {
      el2.removeEventListener("scroll", onScroll);
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logRef.current]);
  return (
    <div className="log-follow">
      {children}
      {follow.away && (
        <button type="button" className="v2-btn v2-btn-secondary v2-btn-sm log-jump" onClick={follow.jump}>
          <span className="v2-btn-label">{follow.unseen ? "New lines · Jump to latest" : "Jump to latest"}</span>
        </button>
      )}
    </div>
  );
}

/** Conversation work-log body. A FINISHED run paints the output it already
 *  captured (review: it used to wait on SSE forever); only a running (or not
 *  yet loaded) run streams, and a failed stream falls back to the captured
 *  output or an honest "Log unavailable". */
export function WorkLogStream({ agentId, runId, run }: { agentId: string; runId: string; run?: Run | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const finished = !!run && run.status !== "running";
  const output = run?.output || "";
  useEffect(() => {
    const logEl = ref.current;
    if (!logEl) return;
    logEl.innerHTML = "";
    if (finished && run) {
      paintFinished(logEl, run);
      return;
    }
    return startRunStream(logEl, agentId, runId, () => {
      logEl.innerHTML = "";
      if (output.trim()) paintFinished(logEl, { output, status: run?.status || "", exit_code: run?.exit_code });
      else appendLine(logEl, { type: "narrate", label: "log", text: "Log unavailable." });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, runId, finished]);
  return (
    <FollowLog logRef={ref}>
      <div className="log" id={"convlog-" + runId} ref={ref} onClick={onLogSectionClick} />
    </FollowLog>
  );
}

/* ---- SPEC-2 T2: graceful Stop of a single worker run --------------------- */
// run_ids a human has requested a stop for THIS session (module-level so the
// 'Stop requested' relabel stays sticky across repaints, like the vanilla Set).
const stopRequestedRuns = new Set<string>();
function killCause(kr: string | null | undefined): string {
  try {
    return ((JSON.parse(kr || "") || {}) as any).cause || "";
  } catch {
    return "";
  }
}
/** A kill_reason as readable text: the JSON cause/reason/message, else the raw
 *  string itself (review: a plain-string reason used to be dropped). */
export function killReasonText(kr: string | null | undefined): string {
  const raw = String(kr || "").trim();
  if (!raw) return "";
  try {
    const v = JSON.parse(raw) as any;
    if (v && typeof v === "object") {
      const t = v.reason || v.message || v.detail || (typeof v.cause === "string" ? v.cause.replace(/_/g, " ") : "");
      return typeof t === "string" ? t : "";
    }
    return typeof v === "string" ? v : raw;
  } catch {
    return raw;
  }
}

/**
 * The ONE Stop-run flow (agent Runs tab, Activity inspector, the conversation
 * composer's circular stop). Human-gated (POST /api/runs/{id}/stop 403s
 * non-humans), confirm-first with the honest graceful-stop copy; stopping a run
 * never stops the project or other runs. `dialog` must be rendered by the caller.
 */
export function useStopRun(run: Run | null | undefined): { request: () => void; stopRequested: boolean; dialog: ReactNode } {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [, tick] = useState(0);
  const rid = run ? String(run.run_id || run.id || "") : "";
  const stopRequested = !!rid && stopRequestedRuns.has(rid);

  const request = () => {
    if (!rid) return;
    const h = actingHuman(snap);
    if (!h) { toast("Pick an acting human first.", "danger"); return; } // human-gated (POST /stop 403s non-humans)
    if (stopRequestedRuns.has(rid)) { toast("Stop already requested for this run.", "warn"); return; }
    setConfirmStop(true);
  };
  const doStop = () => {
    setConfirmStop(false);
    const h = actingHuman(snap);
    if (!h) { toast("Pick an acting human first.", "danger"); return; }
    sendJSON<any>("POST", "/api/runs/" + encodeURIComponent(rid) + "/stop", { actor_agent_id: h.id })
      .then((d) => {
        // Three 200 shapes from POST /api/runs/{id}/stop: already_finished → nothing live to
        // signal; already_requested → a prior stop is already pending (still mark + relabel);
        // fresh stop → stop_requested recorded.
        if (d && d.already_finished) { toast("Run already " + (d.status || "finished") + ".", "warn"); return; }
        stopRequestedRuns.add(rid);
        tick((n) => n + 1);
        toast(d && d.already_requested ? "Stop already requested." : "Stop requested — the worker halts on the next tick.", "ok");
      })
      .catch((e) => toast("Stop failed (" + (((e as { status?: number }).status ?? (e as Error).message) || e) + ").", "danger"));
  };
  const dialog = confirmStop ? (
    <ConfirmDialog
      title="Stop this run?"
      // Honesty (graceful stop): the API only RECORDS the intent; the host daemon reaps the
      // worker on its next wake-renew tick — it is NOT an instant kill. r3 (D12): one line
      // of body; the mechanics live in the info tooltip, never the raw id or a status enum.
      description={
        <span className="run-stop-desc">
          The worker stops at its next checkpoint — only this run; the task and project keep going.
          <span className="run-stop-info" tabIndex={0} role="note" title={STOP_DETAIL} aria-label={STOP_DETAIL}>
            <Icon name="info" cls="v2-ico" />
          </span>
        </span>
      }
      danger
      confirmLabel="Stop run"
      onConfirm={doStop}
      onClose={() => setConfirmStop(false)}
    />
  ) : null;
  return { request, stopRequested, dialog };
}

export function StopRunButton({ run }: { run: Run }) {
  const stop = useStopRun(run);
  const rid = String(run.run_id || run.id || "");
  if (run.status !== "running") return null;
  const stopReq = stop.stopRequested;
  return (
    <>
      {/* D2: a quiet secondary with a red stop glyph — never a red slab inline */}
      <Button
        variant="secondary"
        size="sm"
        icon="stop"
        className="run-stop"
        data-run-stop={rid}
        disabled={stopReq}
        title={stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run (the project and other runs keep going)"}
        onClick={stop.request}
      >
        {stopReq ? "Stop requested" : "Stop run"}
      </Button>
      {stop.dialog}
    </>
  );
}

const STOP_DETAIL =
  "A graceful stop: the host daemon ends the worker on its next wake tick, not instantly. " +
  "The task stays in progress so you can reassign it or wake the agent again.";

/** The first real error line in a run's captured output ("" when none): a plain
 *  stderr error (ENOENT, Traceback, "Error: …"), a Codex error event, or the
 *  result line of a run that ended in error. Warnings are not errors. */
const ERR_LINE = /\b(ENOENT|EACCES|EPERM|ECONNREFUSED|Traceback|Exception|panic:|fatal:)|(^|\s)(Error|error|ERROR)[:\s]/;
export function outputErrorLine(output: string | null | undefined): string {
  for (const raw of String(output || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.charAt(0) === "{") {
      let o: any = null;
      try { o = JSON.parse(line); } catch { o = null; }
      if (o && typeof o === "object") {
        if (o.type === "result" && (o.is_error || /^error/.test(String(o.subtype || "")))) {
          const t = [o.result, o.error, String(o.subtype || "").replace(/_/g, " ")].find((x) => typeof x === "string" && x.trim()) || "";
          if (t.trim()) return oneLine(t);
        }
        const ev = classifyLine(line).find((e) => e.type === "error");
        if (ev && ev.text && ev.text !== "error") return oneLine(ev.text);
        continue;
      }
    }
    if (/^(warn|warning)\b/i.test(line) || /\bWARNING\b/.test(line)) continue;
    if (ERR_LINE.test(line)) return oneLine(line);
  }
  return "";
}
function oneLine(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 159).replace(/\s+\S*$/, "") + "…" : s;
}

/** Why a failed/stopped run ended, as one readable line ("" when it didn't fail).
 *  A kill with no machine cause uses the raw kill_reason text before the generic
 *  "no reason recorded" (review: a plain-string reason used to be dropped). */
export function runReasonText(run: Pick<Run, "status" | "exit_code" | "kill_reason"> & { output?: string | null }): string {
  const o = runOutcome(run);
  if (o.bucket !== "failed") return "";
  const kr = run.status === "killed" && !killCause(run.kill_reason) ? killReasonText(run.kill_reason) : "";
  const r = kr || o.reason || "";
  // r3: a bare "Exited with code 1" hides the captured cause (spawn … ENOENT) — the
  // output's first error line is the reason; the exit code stays in the row tooltip
  if (!kr && (!r || EXIT_REASON.test(r))) {
    const err = outputErrorLine(run.output);
    if (err) return err;
  }
  return r ? reasonText(r) : "";
}
const EXIT_REASON = /^(?:non-zero exit code |exit )(-?\d+)$/;
export function reasonText(reason: string): string {
  const m = EXIT_REASON.exec(reason);
  return m ? "Exited with code " + m[1] : reason.charAt(0).toUpperCase() + reason.slice(1);
}

function RunCard({ run, agentAlias }: { run: Run; agentAlias?: string }) {
  const { snap } = useSnapshot();
  const rid = String(run.run_id || run.id || "");
  const live = run.status === "running";
  const started = run.started_at || run.started;
  const ended = run.ended_at || run.ended;
  const killed = run.status === "killed";
  // #299 honesty: a human-stopped run ALSO reaps as status='killed' (kill_reason.cause=
  // 'human_stop'); only a watchdog stall/cap kill should read 'watchdog-killed'.
  // a plain-string kill_reason has no machine cause: never guess "watchdog" then
  const cause = killed ? killCause(run.kill_reason) : "";
  const killTag = cause === "human_stop" ? "stopped by a human" : cause === "stalled" || cause === "hard_cap" ? "watchdog-killed" : "";
  const outcome = runOutcome(run);
  const reason = runReasonText(run);
  const dur = runDuration(run, Date.now());
  const wr = run as Run & { task_id?: string | null };
  // wave-4 (D12): the wake kind ("headless", "live tab") is mechanics — tooltip only
  const kind = run.wake_kind === "tmux" ? "live tab" : run.wake_kind || "";
  const taskTitle = wr.task_id ? ((snap?.tasks ?? []).find((t) => String(t.id) === String(wr.task_id))?.title || "") : "";
  const failed = outcome.bucket === "failed";
  // r2: only the RUNNING run opens by default — a finished run is ONE line (status ·
  // kind · when · reason) that expands to its diff + log (the tab read as a wall of logs)
  const [open, setOpen] = useState(live);
  const label = outcome.label ? outcome.label.charAt(0).toUpperCase() + outcome.label.slice(1) : outcome.label;
  const bodyId = "run-body-" + rid;

  return (
    <div className={"run" + (failed ? " is-failed" : "") + (live ? " is-live" : "") + (open ? " is-open" : "")} data-run={rid}>
      {/* r3: the whole header row is the disclosure (links / Stop keep their own clicks) */}
      <div
        className="run-h"
        title={"Run " + rid + (kind ? " · " + kind + " wake" : "") + (run.exit_code != null && !live ? " · exit code " + run.exit_code : "")}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button, [role=note]")) return;
          if (window.getSelection && String(window.getSelection() || "")) return; // selecting text is not a click
          setOpen((o) => !o);
        }}
      >
        <button
          type="button"
          className="run-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={(open ? "Collapse" : "Expand") + " run " + shortId(rid)}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="chev" cls="v2-ico run-chev" />
        </button>
        {/* status ONCE: glyph + the exact outcome label (capitalised like every other outcome) */}
        <StatusIcon status={outcome.dot} label={label} showLabel />
        {killTag ? <span className="run-kind">{killTag}</span> : null}
        <span className="when" title={started ? new Date(started).toLocaleString() : undefined}>
          {started ? clockTime(started) + (ended ? " → " + clockTime(ended) : " → now") : "—"}
          {!live && started ? " · " + relTime(ended || started) : ""}
          {dur ? " · " + dur : ""}
        </span>
        {/* the failure reason rides the row (one line per finished run) */}
        {reason ? <span className="run-reason" title={reason}>{reason}</span> : <span className="grow" />}
        {/* links trail the header row (review: they used to take a full line per run) */}
        <span className="run-links">
          {wr.task_id ? (
            <Link className="run-task" to={"/tasks?task=" + encodeURIComponent(wr.task_id)} title={taskTitle ? "Open task · " + taskTitle : "Open the task this run worked on"}>
              <span className="run-task-t">{taskTitle || "Task"}</span> <Icon name="arrow" cls="v2-ico" />
            </Link>
          ) : null}
          {agentAlias ? (
            <Link to={"/activity?agent=" + encodeURIComponent(agentAlias) + "&run=" + encodeURIComponent(rid)} title={"Open run " + shortId(rid) + " in Activity"}>
              Activity <Icon name="arrow" cls="v2-ico" />
            </Link>
          ) : null}
        </span>
        <StopRunButton run={run} />
      </div>
      {open ? (
        <div className="run-body" id={bodyId}>
          {run.diff != null && (
            <details className="run-diff">
              <summary>
                <Icon name="chev" cls="v2-ico run-chev" />
                Code diff
              </summary>
              <div className="run-diff-b"><FilesChanged diff={run.diff} blobSource={runBlobSource(run)} /></div>
            </details>
          )}
          {/* wave-4 (D12): ONE run-log renderer app-wide — the Activity inspector's RunLogView
              (sentence-case kinds, inline "› Details", key/value details, never raw JSON);
              the stream state rides its own header ("Live stream" / "Captured output") */}
          <div className="run-log">
            <RunLogView key={rid + ":" + run.status} run={run} outcome={{ bucket: outcome.bucket, stoppedByHuman: cause === "human_stop" }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---- the Worker runs card (agents.html renderRuns) ----------------------- */
export type FeedState = { alias: string; runs: Run[]; error?: false } | { alias: string; error: true };

/**
 * ONE /runs read per agent workspace, re-read on every snapshot bump. The Runs
 * tab AND the workspace header (presence, "Running …" meta, failure reason)
 * read this same list, so they can never disagree (review blocker).
 */
export function useAgentRuns(agent: Agent | null): FeedState | null {
  const { bump } = useSnapshot();
  const [state, setState] = useState<FeedState | null>(null);
  const sigRef = useRef("");
  const aliasRef = useRef<string | null>(null);
  const tokenRef = useRef(0); // guards against stale async runs responses across selects
  const aid = agent && agent.kind !== "human" ? agent.id : null;
  const alias = agent ? agent.alias : "";

  useEffect(() => {
    if (!aid) return;
    const agent = { id: aid, alias };
    const myToken = ++tokenRef.current;
    fetch("/api/agents/" + encodeURIComponent(agent.id) + "/runs")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: any) => {
        if (myToken !== tokenRef.current) return; // a newer select/tick superseded us
        const runs: Run[] = Array.isArray(d) ? d : d.runs || [];
        const sig = runs.map((x) => (x.run_id || x.id) + ":" + x.status).join("|");
        if (agent.alias === aliasRef.current && sig === sigRef.current) return; // nothing changed; keep live streams
        aliasRef.current = agent.alias;
        sigRef.current = sig;
        setState({ alias: agent.alias, runs });
      })
      .catch(() => {
        if (myToken !== tokenRef.current) return;
        if (agent.alias !== aliasRef.current) {
          aliasRef.current = agent.alias;
          sigRef.current = "";
          setState({ alias: agent.alias, error: true });
        }
      });
  }, [aid, alias, bump]);
  return state && state.alias === alias ? state : null;
}

export function RunsFeed({ agent, feed }: { agent: Agent; feed?: FeedState | null }) {
  const own = useAgentRuns(feed === undefined ? agent : null);
  const state = feed === undefined ? own : feed;
  if (!state || state.alias !== agent.alias) return <div className="none" role="status">Loading worker runs…</div>;
  if (state.error) {
    return (
      <div className="runs-feed">
        <div className="none" role="alert">Run feed unavailable — the runs endpoint did not respond. It retries on the next refresh.</div>
      </div>
    );
  }
  const runs = state.runs;
  const running = runs.filter((x) => x.status === "running").length;
  return (
    <div className="runs-feed">
      <div className="runs-h">
        <span className="muted">
          {runs.length} most recent run{runs.length === 1 ? "" : "s"}
          {running ? " · " + running + " running" : ""}
        </span>
        <span
          className="runs-info"
          tabIndex={0}
          role="note"
          title={`Each wake is a fresh worker session — lines are classified by event type; tool details expand. ${agent.alias} is one continuous agent across all of them. A run exiting is not the same as its task being verified.`}
          aria-label={`About runs: each wake is a fresh worker session; ${agent.alias} is one continuous agent across all of them. A run exiting is not the same as its task being verified.`}
        >
          <Icon name="info" cls="v2-ico" />
        </span>
        <span className="grow" />
        <Link className="v2-btn v2-btn-ghost v2-btn-sm" to={"/activity?agent=" + encodeURIComponent(agent.alias)}>
          <span className="v2-btn-label">All activity</span>
          <Icon name="arrow" cls="v2-ico" />
        </Link>
      </div>
      {runs.length ? (
        <div className="runs-list">
          {runs.map((r) => (
            <RunCard key={String(r.run_id || r.id) + ":" + r.status} run={r} agentAlias={agent.alias} />
          ))}
        </div>
      ) : (
        <div className="none">No worker runs yet — runs appear here each time {agent.alias} wakes.</div>
      )}
    </div>
  );
}

/* ---- D9 conversation run detail (Linear agent panel, images 10/16) -------- */
// success words a finished run may report (forward-compat: never read as failure)
const RUN_OK = /^(completed|succeeded|success|done)$/;

/** Mounts its children only once it is actually shown (the WorkedFor body is
 *  `hidden` until opened), so a collapsed "Worked for …" never opens a stream. */
function WhenShown({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(() => typeof ResizeObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (shown || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.getClientRects().length) {
        setShown(true);
        ro.disconnect();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);
  // a 1px block: its size changes the moment the hidden body is shown (RO fires then)
  return shown ? <>{children}</> : <span ref={ref} className="worklog-probe" style={{ display: "block", height: 1 }} />;
}

/** The "Worked for 10 sec ▸" line for a conversation turn's run: duration from
 *  the run's own start/end stamps (unknown → no number, never "0 sec"), the
 *  exact outcome when it didn't finish cleanly, and the live work log on expand. */
export function runWorkedLabel(run: Run | null | undefined, now: number): { ms: number | null; running: boolean; label?: string } {
  if (!run) return { ms: null, running: false, label: "Work log" };
  const running = run.status === "running";
  const s = Date.parse(runStarted(run) || "");
  const e = Date.parse(runEnded(run) || "");
  const ms = s ? (e ? e - s : running ? now - s : null) : null;
  if (running || RUN_OK.test(run.status)) return { ms, running };
  const o = runOutcome(run);
  if (o.bucket !== "failed") return { ms, running };
  const d = formatDuration(ms);
  return { ms, running, label: d ? o.label + " after " + d : o.label };
}

/** Work log inside a conversation turn (streams its run on first expand). */
export function WorkLogDetails({ agentId, runId, run, at }: { agentId: string; runId: string; run?: Run | null; at?: string | null }) {
  const w = runWorkedLabel(run, Date.now());
  // D16: the duration is the headline; the turn's relative time trails it (absolute in its tooltip)
  const s = run ? runStarted(run) : null;
  const e = run ? runEnded(run) : null;
  const span = s ? "Run " + runId.slice(0, 8) + " · " + new Date(s).toLocaleString() + (e ? " → " + new Date(e).toLocaleTimeString() : "") : "Run " + runId.slice(0, 8);
  return (
    <div className="worklog" data-run={runId} title={span}>
      <WorkedFor ms={w.ms} running={w.running} label={w.label} meta={at ? <RelTime at={at} className="tt" /> : undefined}>
        <WhenShown>
          <WorkLogStream agentId={agentId} runId={runId} run={run} />
        </WhenShown>
      </WorkedFor>
    </div>
  );
}

/* ---- D16 live "AI working" row ------------------------------------------ */

/** A live timer: "12s", "1m 03s", "1h 04m" (unknown / negative → null). */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

const baseName = (p: unknown) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
const clip = (t: string, n = 90) => {
  const v = t.replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : v;
};
/**
 * The current-activity line for a live run, derived ONLY from what the run's own
 * stream said (a tool call's name/input, or the agent's narration). Anything
 * else (thinking, tool results, lifecycle, raw log noise) returns null so the
 * previous real activity stays — nothing is ever invented.
 */
export function activityText(e: Pick<LogEvent, "type" | "label" | "text" | "detail">): string | null {
  if (e.type === "tool" || e.type === "decision") {
    if (e.type === "decision" && e.label !== "orcha-action") return null;
    const name = String(e.text || "").trim();
    if (!name) return null;
    let input: any = null;
    try { input = e.detail ? JSON.parse(e.detail) : null; } catch { input = null; }
    const i = input && typeof input === "object" ? input : {};
    if (typeof i.description === "string" && i.description.trim()) return clip(i.description);
    const file = baseName(i.file_path || i.path || i.notebook_path);
    switch (name) {
      case "Read": return file ? "Reading " + file : "Reading files";
      case "Edit": case "MultiEdit": case "NotebookEdit": case "apply_patch": return file ? "Editing " + file : "Editing files";
      case "Write": return file ? "Writing " + file : "Writing files";
      case "Grep": case "Glob": return i.pattern ? clip("Searching " + String(i.pattern), 70) : "Searching";
      case "Bash": return i.command ? clip("Running " + String(i.command).split("\n")[0], 80) : "Running a command";
      case "WebFetch": case "WebSearch": return "Searching the web";
      case "Task": case "Agent": return "Delegating to a subagent";
      case "TodoWrite": return "Updating its plan";
      default: return e.type === "decision" ? "Updating Embodent" : "Using " + name;
    }
  }
  if (e.type === "narrate" && (e.label === "narration" || e.label === "progress")) {
    const first = String(e.text || "").split("\n").find((l) => l.trim());
    return first ? clip(first) : null;
  }
  if (e.type === "subagent") return e.text ? clip(e.text) : null;
  return null;
}

/* ---- live chat: ONE shared EventSource per live run ---------------------- */
// Every live-turn consumer (the Working… row's activity, the streamed reply) reads the
// same run through this hub, so a conversation opens one stream per run, not one per hook.
// Lines are buffered (capped) and replayed to a late subscriber; a reconnect resumes with
// ?after_seq= (and the browser's own retry sends Last-Event-ID), and the monotonic seq
// guard drops any overlap, so no line is ever applied twice.
export type RunStreamMsg = { seq: number; line: string } | { done: true; status: string | null };
type RunHubEntry = {
  agentId: string;
  runId: string;
  es: EventSource | null;
  maxSeq: number;
  lines: Array<{ seq: number; line: string }>;
  done: { status: string | null } | null;
  listeners: Set<(m: RunStreamMsg) => void>;
  retryT: ReturnType<typeof setTimeout> | null;
  closeT: ReturnType<typeof setTimeout> | null;
  retries: number;
};
const runHub = new Map<string, RunHubEntry>();
const HUB_BUFFER = 4000; // lines kept for late subscribers
const HUB_GRACE_MS = 3000; // keep a stream open briefly after its last subscriber leaves (remounts)

function hubClose(e: RunHubEntry) {
  if (e.retryT) { clearTimeout(e.retryT); e.retryT = null; }
  if (e.es) {
    try { e.es.close(); } catch { /* already closed */ }
    e.es = null;
  }
}
function hubEmit(e: RunHubEntry, m: RunStreamMsg) {
  e.listeners.forEach((fn) => {
    try { fn(m); } catch { /* one consumer never breaks another */ }
  });
}
function hubOpen(e: RunHubEntry) {
  if (e.done || e.es) return;
  const url = "/api/agents/" + encodeURIComponent(e.agentId) + "/runs/" + encodeURIComponent(e.runId) + "/stream" + (e.maxSeq > 0 ? "?after_seq=" + e.maxSeq : "");
  let es: EventSource;
  try { es = new EventSource(url); } catch { return; }
  e.es = es;
  es.onmessage = (ev) => {
    let d: any;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (!d) return;
    e.retries = 0;
    if (d.done) {
      hubClose(e);
      if (d.status === "stream_timeout") { hubOpen(e); return; } // 30-min server cap: resume
      e.done = { status: d.status == null ? null : String(d.status) };
      hubEmit(e, { done: true, status: e.done.status });
      return;
    }
    if (typeof d.seq === "number" && typeof d.line === "string") {
      if (d.seq <= e.maxSeq) return; // monotonic — drops reconnect replay
      e.maxSeq = d.seq;
      const m = { seq: d.seq, line: d.line };
      e.lines.push(m);
      if (e.lines.length > HUB_BUFFER) e.lines.splice(0, e.lines.length - HUB_BUFFER);
      hubEmit(e, m);
    }
  };
  es.onerror = () => {
    // CONNECTING: the browser retries by itself (with Last-Event-ID). CLOSED (e.g. a
    // non-200): reopen ourselves with backoff, resuming after the last seq we hold.
    if ((es as { readyState?: number }).readyState !== 2 || e.done) return;
    if (e.es === es) e.es = null;
    try { es.close(); } catch { /* already closed */ }
    if (e.retryT || !e.listeners.size) return;
    const wait = Math.min(10_000, 1000 * 2 ** Math.min(e.retries++, 4));
    e.retryT = setTimeout(() => { e.retryT = null; if (e.listeners.size) hubOpen(e); }, wait);
  };
}

/** Subscribe to a live run's stream (shared). Buffered lines and a terminal done are
 *  replayed synchronously to the new subscriber. Returns the unsubscribe. */
export function subscribeRunStream(agentId: string, runId: string, fn: (m: RunStreamMsg) => void): () => void {
  if (typeof EventSource === "undefined" || !agentId || !runId) return () => {};
  const key = agentId + "/" + runId;
  let e = runHub.get(key);
  if (!e) {
    e = { agentId, runId, es: null, maxSeq: 0, lines: [], done: null, listeners: new Set(), retryT: null, closeT: null, retries: 0 };
    runHub.set(key, e);
  }
  const entry = e;
  if (entry.closeT) { clearTimeout(entry.closeT); entry.closeT = null; }
  entry.listeners.add(fn);
  for (const m of entry.lines.slice()) fn(m);
  if (entry.done) fn({ done: true, status: entry.done.status });
  else hubOpen(entry);
  return () => {
    entry.listeners.delete(fn);
    if (entry.listeners.size) return;
    if (entry.closeT) clearTimeout(entry.closeT);
    entry.closeT = setTimeout(() => {
      entry.closeT = null;
      if (entry.listeners.size) return;
      hubClose(entry);
      if (runHub.get(key) === entry) runHub.delete(key);
    }, HUB_GRACE_MS);
  };
}
/** Test hook: drop every shared stream (closing its EventSource). */
export function _resetRunStreamHub(): void {
  runHub.forEach((e) => { hubClose(e); if (e.closeT) clearTimeout(e.closeT); });
  runHub.clear();
}

/** Coalesce state pushes to one per animation frame (setTimeout where there is none). */
function frameScheduler(fn: () => void): { schedule: () => void; cancel: () => void } {
  let h: number | ReturnType<typeof setTimeout> | null = null;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  return {
    schedule: () => {
      if (h != null) return;
      const run = () => { h = null; fn(); };
      h = raf ? raf(run) : setTimeout(run, 16);
    },
    cancel: () => {
      if (h == null) return;
      if (raf && typeof h === "number" && typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
      else clearTimeout(h as ReturnType<typeof setTimeout>);
      h = null;
    },
  };
}

/**
 * Tail a live run's SSE stream just for its latest real activity. `ended`
 * flips true the moment the stream reports the run finished (before the next
 * runs poll), so the working row disappears exactly when the run ends.
 */
export function useRunActivity(agentId: string, runId: string | null): { activity: string | null; ended: boolean } {
  const [activity, setActivity] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    setActivity(null);
    setEnded(false);
    if (!runId) return;
    let latest: string | null = null;
    let stopped = false;
    // a replayed / bursty stream coalesces into one paint per frame
    const frame = frameScheduler(() => { if (!stopped) setActivity(latest); });
    const unsub = subscribeRunStream(agentId, runId, (m) => {
      if ("done" in m) {
        if (m.status !== "stream_timeout" && !stopped) setEnded(true);
        return;
      }
      for (const e of classifyLine(m.line)) {
        const t = activityText(e);
        if (t) latest = t;
      }
      frame.schedule();
    });
    return () => {
      stopped = true;
      frame.cancel();
      unsub();
    };
  }, [agentId, runId]);
  return { activity, ended };
}

/* ---- live chat: the in-progress reply of a live run ---------------------- */

export type LiveTurnStep = { kind: "tool" | "think" | "text"; label: string; at: number };
/** `status` is the run's terminal status from its stream's {done} message (null while live,
 *  or when the stream ended without saying) — "killed" / "failed" / "rate_limited" mean the
 *  reply never came (C9b). */
export type LiveTurn = { text: string; steps: LiveTurnStep[]; activity: string | null; done: boolean; startedAt: number | null; status: string | null };
export type LiveTurnModel = {
  blocks: string[]; // completed text blocks of the current segment
  partial: string; // streamed text of the block being written now
  steps: LiveTurnStep[];
  toolStep: Record<string, number>; // tool_use id → index in steps (label upgrades in place)
  activity: string | null;
  done: boolean;
  startedAt: number | null;
  status: string | null;
};
const LIVE_STEPS_MAX = 200;
export function emptyLiveTurn(): LiveTurnModel {
  return { blocks: [], partial: "", steps: [], toolStep: {}, activity: null, done: false, startedAt: null, status: null };
}
function segText(m: LiveTurnModel): string {
  const parts = m.blocks.slice();
  if (m.partial) parts.push(m.partial);
  return parts.join("\n\n");
}
function pushStep(m: LiveTurnModel, s: LiveTurnStep): number {
  m.steps.push(s);
  if (m.steps.length > LIVE_STEPS_MAX) {
    const drop = m.steps.length - LIVE_STEPS_MAX;
    m.steps.splice(0, drop);
    for (const k of Object.keys(m.toolStep)) {
      m.toolStep[k] -= drop;
      if (m.toolStep[k] < 0) delete m.toolStep[k];
    }
  }
  return m.steps.length - 1;
}
/** A tool starts: the text written so far was narration before it — it becomes a
 *  "text" step and the reply text starts over (the reply is what follows the last tool). */
function closeSegment(m: LiveTurnModel, at: number) {
  const t = segText(m).trim();
  if (t) pushStep(m, { kind: "text", label: clip(t.split("\n").find((l) => l.trim()) || t), at });
  m.blocks = [];
  m.partial = "";
}
function toolStep(m: LiveTurnModel, id: string | null, name: string, input: unknown, at: number) {
  const self = selfAction(name, input);
  const e: LogEvent = { type: self ? "decision" : "tool", label: self ? "orcha-action" : "tool", text: name, detail: JSON.stringify(input || {}) };
  const label = activityText(e) || "Using " + name;
  if (id && m.toolStep[id] != null && m.steps[m.toolStep[id]]) {
    m.steps[m.toolStep[id]] = { ...m.steps[m.toolStep[id]], label };
  } else {
    closeSegment(m, at);
    const i = pushStep(m, { kind: "tool", label, at });
    if (id) m.toolStep[id] = i;
  }
  m.activity = label;
}
function thinkStep(m: LiveTurnModel, at: number) {
  const last = m.steps[m.steps.length - 1];
  if (last && last.kind === "think" && !segText(m)) return; // same thinking burst
  pushStep(m, { kind: "think", label: "Thinking", at });
}

/**
 * Fold one real stream message into the live-turn model (mutates and returns it).
 * Derived ONLY from the run's own stream: Claude text deltas (stream_event
 * text_delta), complete assistant blocks (text / thinking / tool_use), block starts
 * (tool_use / thinking), and — for other runtimes — classified narration / tool rows.
 * Subagent output (parent_tool_use_id set) never enters the reply text.
 */
export function reduceLiveTurn(m: LiveTurnModel, msg: RunStreamMsg, at: number = Date.now()): LiveTurnModel {
  if (m.startedAt == null) m.startedAt = at;
  if ("done" in msg) {
    if (msg.status !== "stream_timeout") {
      m.done = true;
      m.status = msg.status == null ? null : String(msg.status);
    }
    return m;
  }
  let o: any = null;
  try { o = JSON.parse(msg.line); } catch { o = null; }
  const sub = !!(o && o.parent_tool_use_id);
  if (o && o.type === "stream_event" && o.event && typeof o.event === "object") {
    if (sub) return m;
    const ev = o.event;
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
      m.partial += ev.delta.text;
    } else if (ev.type === "content_block_start" && ev.content_block) {
      const b = ev.content_block;
      if (b.type === "tool_use") toolStep(m, b.id ? String(b.id) : null, String(b.name || "tool"), b.input, at);
      else if (b.type === "thinking") thinkStep(m, at);
    }
    return m;
  }
  if (o && o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
    for (const c of o.message.content) {
      if (!c || typeof c !== "object") continue;
      if (sub) {
        if (c.type === "tool_use") { const t = activityText({ type: "tool", label: "tool", text: String(c.name || ""), detail: JSON.stringify(c.input || {}) }); if (t) m.activity = t; }
        continue;
      }
      if (c.type === "text" && typeof c.text === "string") {
        // the complete block supersedes the deltas that streamed it
        if (c.text.trim()) m.blocks.push(c.text);
        m.partial = "";
      } else if (c.type === "thinking" || c.type === "redacted_thinking") thinkStep(m, at);
      else if (c.type === "tool_use") toolStep(m, c.id ? String(c.id) : null, String(c.name || "tool"), c.input, at);
    }
    const t = segText(m).split("\n").find((l) => l.trim());
    if (t && !sub) m.activity = clip(t);
    return m;
  }
  if (o && (o.type === "user" || o.type === "system" || o.type === "result" || o.type === "rate_limit_event")) return m;
  // other runtimes (Codex): complete messages are blocks, *_delta events stream the partial
  const kind = String((o && ((o.msg && o.msg.type) || (o.event && o.event.type) || o.type)) || "");
  for (const e of classifyLine(msg.line)) {
    if (e.type === "narrate" && e.label === "narration" && e.text) {
      if (/delta/i.test(kind)) m.partial += e.text;
      else { m.blocks.push(e.text); m.partial = ""; }
    } else if (e.type === "tool" || (e.type === "decision" && e.label === "orcha-action")) {
      let input: unknown = {};
      try { input = e.detail ? JSON.parse(e.detail) : {}; } catch { input = {}; }
      toolStep(m, null, e.text, input, at);
      continue;
    } else if (e.type === "think") thinkStep(m, at);
    const a = activityText(e);
    if (a) m.activity = a;
  }
  return m;
}
export function liveTurnView(m: LiveTurnModel): LiveTurn {
  return { text: segText(m), steps: m.steps.slice(), activity: m.activity, done: m.done, startedAt: m.startedAt, status: m.status };
}

/**
 * The in-progress reply of a live run, streamed like a terminal: `text` grows with
 * every text delta the agent emits (the reply = the text written since its last tool
 * call; earlier narration moves into `steps` as a "text" step), `steps` are its tool
 * calls / thinking bursts / narration in order with human labels (activityText),
 * `activity` is the latest real activity line, `done` flips when the run's stream
 * reports it finished, `startedAt` is when this viewer first saw its output (use the
 * run's own started_at for elapsed time). Nothing is invented: everything comes from
 * the run's stream, applied incrementally and painted at most once per animation frame.
 * Reconnect-safe (shared hub: seq-deduped, resumes after the last seq).
 */
export function useLiveTurn(agentId: string, runId: string | null): LiveTurn {
  const [view, setView] = useState<LiveTurn>(() => liveTurnView(emptyLiveTurn()));
  useEffect(() => {
    const model = emptyLiveTurn();
    setView(liveTurnView(model));
    if (!runId) return;
    let stopped = false;
    const frame = frameScheduler(() => { if (!stopped) setView(liveTurnView(model)); });
    const unsub = subscribeRunStream(agentId, runId, (m) => {
      if (model.done) return;
      reduceLiveTurn(model, m);
      frame.schedule();
    });
    return () => {
      stopped = true;
      frame.cancel();
      unsub();
    };
  }, [agentId, runId]);
  return view;
}

/** Re-render every second while `on` (a live elapsed timer). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [on]);
  return now;
}

/**
 * D16: the thread's live "AI working" row — shown ONLY while a real run is
 * running on this conversation (the caller decides; `onEnded` fires the moment
 * the run's own stream reports it finished). A Linear shimmer on "Working…"
 * (static under reduced motion), a live elapsed timer from the run's real
 * start, the current activity from the run's stream when it has said anything,
 * and the live work log on expand.
 */
export function LiveWorkingRow({ agentId, alias, run, onEnded }: { agentId: string; alias: string; run: Run; onEnded?: () => void }) {
  const rid = String(run.run_id || run.id || "");
  const { activity, ended } = useRunActivity(agentId, rid);
  const now = useNow(!ended);
  useEffect(() => {
    if (ended) onEnded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);
  const started = Date.parse(runStarted(run) || "");
  const elapsed = started ? formatElapsed(Math.max(0, now - started)) : null;
  if (ended) return null;
  const startedTitle = started ? "Started " + new Date(started).toLocaleString() : undefined;
  return (
    <div className="conv-working" data-run={rid}>
      <span className="ag-sr" role="status">{alias} is working</span>
      <WorkedFor
        running
        label={
          <>
            <span className="conv-shimmer" aria-hidden="true">Working…</span>
            {elapsed ? <span className="conv-elapsed" title={startedTitle} aria-hidden="true">{elapsed}</span> : null}
            <span className="ag-sr">{alias} is working{elapsed ? " · " + elapsed : ""} — show the live work log</span>
          </>
        }
      >
        <WhenShown>
          <WorkLogStream agentId={agentId} runId={rid} run={run} />
        </WhenShown>
      </WorkedFor>
      {activity ? <div className="conv-activity" title={activity}>{activity}</div> : null}
    </div>
  );
}

/** A file's diff lines from its first @@ hunk on. A file with no hunk (binary,
 *  pure rename / mode change) keeps only its human-readable meta lines. */
export function diffBodyLines(lines: string[]): string[] {
  const i = lines.findIndex((l) => l.startsWith("@@"));
  if (i >= 0) return lines.slice(i);
  return lines.filter((l) => /^(Binary files|rename (from|to) |new file|deleted file|old mode|new mode)/.test(l));
}

/** "Changed N files +22 −10" for a run — ONLY from the run's real captured diff
 *  (no PR/branch is invented; nothing renders without a diff). Preview expands
 *  the shared diff viewer in place. */
export function RunChanges({ run }: { run: Run | null | undefined }) {
  const diff = run?.diff || "";
  const files = useMemo(() => (diff ? parseDiffFiles(diff) : []), [diff]);
  // r3: the preview starts at the first @@ hunk — the "diff --git / index / --- / +++"
  // plumbing is already said by the file header (path + M/A/D badge)
  const shown = useMemo(() => files.map((f) => ({ ...f, lines: diffBodyLines(f.lines) })), [files]);
  const [open, setOpen] = useState(false);
  const diffRef = useRef<HTMLDivElement | null>(null);
  // r2: the preview opens below the fold — bring it into view (nearest: no jump when visible)
  useEffect(() => {
    const el = diffRef.current;
    if (open && el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  if (!files.length) return null;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <div className="run-changes">
      <ChangesCard
        files={files.length}
        additions={add}
        deletions={del}
        action={
          <Button variant="ghost" size="sm" icon={open ? "eye-off" : "eye"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Preview"}
          </Button>
        }
      />
      {open ? (
        // the card above already says "Changed N files +a −d": the embedded viewer's own
        // count line is dropped (hideSummary) so the fact is stated once (D12)
        <div className="run-changes-diff" ref={diffRef}>
          <FilesChanged preparsed={shown} hideSummary blobSource={runBlobSource(run)} />
        </div>
      ) : null}
    </div>
  );
}
