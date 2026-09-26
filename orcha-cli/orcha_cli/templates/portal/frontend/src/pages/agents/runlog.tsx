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
import { useEffect, useRef, useState } from "react";
import { sendJSON } from "../../api/client";
import { Icon, Modal, useToast } from "../../components/ui";
import { esc, shortId, relTime, clockTime } from "../../lib/format";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Run } from "../../types";
import { classifyLine, type LogEvent } from "../../lib/classify";
import { nearBottom, pinToBottom } from "../../lib/logScroll";
import { FilesChanged } from "../../components/FilesChanged";

// LogEvent comes from lib/classify; `sec` (section collapse) is a legacy
// vanilla affordance the shared classifier never emits.
type LogRow = LogEvent & { sec?: string };

function logRow(e: LogRow, isNew: boolean): string {
  const t = e.type || "narrate";
  const det = e.detail ? `<span class="det">${esc(e.detail)}</span>` : "";
  return `<div class="ln t-${t}${isNew ? " new" : ""}"><span class="gut">›</span><span class="ty">${esc(e.label || t)}</span><span class="tx">${esc(e.text)}${det}</span></div>`;
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
// group toggle: clicking a .sec hides/shows lines until the next .sec (wireSections)
function onLogSectionClick(ev: React.MouseEvent<HTMLDivElement>) {
  const t = ev.target as Element;
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
export function startRunStream(logEl: HTMLElement, agentId: string, runId: string): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let es: EventSource | null = null,
    maxSeq = 0,
    stopped = false;
  function open() {
    if (stopped) return;
    try {
      es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(runId) + "/stream");
    } catch {
      return;
    }
    es.onmessage = (ev) => {
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
function paintFinished(logEl: HTMLElement, run: Run): void {
  const output = run.output || "";
  if (!output.trim()) {
    appendLine(logEl, { type: "narrate", label: "log", text: "(no captured output)" });
  } else {
    output.split("\n").forEach((line) => {
      if (line.trim()) classifyLine(line).forEach((e) => appendLine(logEl, e));
    });
  }
  appendLine(logEl, {
    type: "done",
    label: "run-complete",
    text: (run.status || "ended") + (run.exit_code != null ? " · exit " + run.exit_code : ""),
  });
}

/** A run's log body: streams while running (agent known), else paints the captured output. */
function LogView({ run }: { run: Run }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rid = String(run.run_id || run.id || "");
  const streamAgent = String(run.agent_id || run.agent || "");
  useEffect(() => {
    const logEl = ref.current;
    if (!logEl) return;
    logEl.innerHTML = "";
    if (run.status === "running" && streamAgent) return startRunStream(logEl, streamAgent, rid);
    paintFinished(logEl, run);
    // the card is keyed on rid:status upstream, so a status flip remounts us
    // (stream torn down, finished log repainted) — exactly the vanilla rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, run.status]);
  return <div className="log" id={"run-" + rid} ref={ref} onClick={onLogSectionClick} />;
}

/** Conversation work-log body: always streams (SSE replays a finished run's lines). */
export function WorkLogStream({ agentId, runId }: { agentId: string; runId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const logEl = ref.current;
    if (!logEl) return;
    logEl.innerHTML = "";
    return startRunStream(logEl, agentId, runId);
  }, [agentId, runId]);
  return <div className="log" id={"convlog-" + runId} ref={ref} onClick={onLogSectionClick} />;
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

function RunCard({ run }: { run: Run }) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [, tick] = useState(0);
  const rid = String(run.run_id || run.id || "");
  const live = run.status === "running";
  const statusTxt = live ? "running" : run.status;
  const started = run.started_at || run.started;
  const ended = run.ended_at || run.ended;
  const killed = run.status === "killed";
  // #299 honesty: a human-stopped run ALSO reaps as status='killed' (kill_reason.cause=
  // 'human_stop'); only a watchdog stall/cap kill should read 'watchdog-killed'.
  const killTag = killed ? (killCause(run.kill_reason) === "human_stop" ? " ■ stopped" : " ⚠ watchdog-killed") : "";
  const stopReq = stopRequestedRuns.has(rid);

  const onStopClick = () => {
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

  return (
    <div className="run">
      <div className="run-h">
        <span className={"rstat " + statusTxt}>
          {statusTxt}
          {run.exit_code != null && !live ? " · exit " + run.exit_code : ""}
          {killTag}
        </span>
        <span className="tag mono">{run.wake_kind === "tmux" ? "live tab" : run.wake_kind || ""}</span>
        {live && (
          <span className="live accent">
            <span className="d" />
            live
          </span>
        )}
        {live && (
          <button
            className="btn sm stop"
            type="button"
            data-run-stop={rid}
            disabled={stopReq}
            title={stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run"}
            onClick={onStopClick}
          >
            <span className="sq" />
            {stopReq ? "Stop requested" : "Stop run"}
          </button>
        )}
        <span className="when">
          {clockTime(started)}
          {ended ? " → " + clockTime(ended) : " …"}
          {started ? " · " + relTime(ended || started) : ""}
        </span>
      </div>
      {run.diff != null && (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--info)", fontSize: "12.5px", padding: "0 15px 10px", fontWeight: 600 }}>code diff</summary>
          <div style={{ padding: "0 15px 14px" }}><FilesChanged diff={run.diff} /></div>
        </details>
      )}
      <details open>
        <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "12.5px", padding: "8px 15px", fontWeight: 600, borderTop: "1px solid var(--border)" }}>
          log{live ? " · streaming" : ""}
        </summary>
        <LogView run={run} />
      </details>
      {confirmStop && (
        <Modal
          title={"Stop run " + shortId(rid) + "?"}
          // Honesty (graceful stop): the API only RECORDS the intent; the host daemon reaps the
          // worker on its next wake-renew tick — it is NOT an instant kill.
          desc={
            "Requests a graceful stop — the worker halts at its next checkpoint (the daemon " +
            "reaps it on the next wake-tick, not instantly). The task stays in_progress for you " +
            "to reassign or rewake."
          }
          danger
          primary="Stop run"
          onPrimary={doStop}
          onClose={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}

/* ---- the Worker runs card (agents.html renderRuns) ----------------------- */
type FeedState = { alias: string; runs: Run[]; error?: false } | { alias: string; error: true };

export function RunsFeed({ agent }: { agent: Agent }) {
  const { bump } = useSnapshot();
  const [state, setState] = useState<FeedState | null>(null);
  const sigRef = useRef("");
  const aliasRef = useRef<string | null>(null);
  const tokenRef = useRef(0); // guards against stale async runs responses across selects

  useEffect(() => {
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
  }, [agent.id, agent.alias, bump]);

  if (!state) return null;
  if (state.error) {
    return (
      <div className="card">
        <div className="card-h">
          <h3>Worker runs</h3>
        </div>
        <div className="card-b" style={{ padding: 14 }}>
          <div className="none">Run feed unavailable.</div>
        </div>
      </div>
    );
  }
  const runs = state.runs;
  const live = runs.some((x) => x.status === "running");
  return (
    <div className="card">
      <div className="card-h">
        <h3>Worker runs</h3>
        <span className="grow" />
        {live ? (
          <span className="live accent">
            <span className="d" />
            live stream
          </span>
        ) : (
          <span className="muted" style={{ fontSize: "11.5px" }}>
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="card-b" style={{ padding: "13px 14px" }}>
        <p className="muted" style={{ fontSize: "12.5px", margin: "0 0 12px" }}>
          Each wake is a fresh headless worker — classified into 9 event types, collapsible by section. {agent.alias} is one continuous agent
          across all of them.
        </p>
        {runs.length ? runs.map((r) => <RunCard key={String(r.run_id || r.id) + ":" + r.status} run={r} />) : <div className="none">No worker runs yet.</div>}
      </div>
    </div>
  );
}

/** Work-log <details> inside a conversation turn (streams its run on first expand). */
export function WorkLogDetails({ agentId, runId }: { agentId: string; runId: string }) {
  const [opened, setOpened] = useState(false); // once opened, the stream stays mounted (vanilla `streamed` cache)
  return (
    <details
      data-run={runId}
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) setOpened(true);
      }}
    >
      <summary className="work-sum">
        <Icon name="play" cls="" />
        work log · {runId.slice(0, 8)}
      </summary>
      {opened ? <WorkLogStream agentId={agentId} runId={runId} /> : <div className="log" />}
    </details>
  );
}
