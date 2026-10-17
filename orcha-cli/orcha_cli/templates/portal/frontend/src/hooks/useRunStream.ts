/**
 * useRunStream — React port of the app.js live-feed engine
 * (startRunStream / paintFinished / appendLine).
 *
 * A RUNNING run streams over one EventSource
 * (/api/agents/{aid}/runs/{rid}/stream): {seq,line} frames are classified via
 * classifyLine and appended; a terminal {done,status} frame closes the stream;
 * status === "stream_timeout" (the 30-min server cap) reopens it; a monotonic
 * `d.seq <= maxSeq` guard drops reconnect replay. A FINISHED run paints once
 * from its captured `output`. Both paths append the vanilla trailing
 * "run-complete" row and cap the feed at 400 rows (appendLine parity).
 *
 * jsdom / older browsers: feature-detects `typeof EventSource` and degrades to
 * an empty live feed (same as the vanilla `return () => {}` guard).
 *
 * V2 (Agent E): `useRunLog` is the same engine exposing each row with a
 * STABLE monotonic id (so React keeps existing DOM nodes — text selection and
 * expanded tool details survive appends and the 400-row cap) plus an honest
 * stream state: "connecting" until the EventSource opens, "live" while open,
 * "reconnecting" after a transport error (EventSource retries by itself),
 * "ended" after the terminal frame, "finished" for a painted finished run and
 * "unsupported" when the browser has no EventSource. Nothing is ever reported
 * as live unless the stream is actually open. `useRunStream` keeps its
 * original signature for Tasks (D) and Code Space LivePanel (F).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { classifyLine, type LogEvent } from "../lib/classify";
import type { Run } from "../types";

const MAX_ROWS = 400; // appendLine's unbounded-growth cap

export type RunStreamState = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "finished" | "unsupported";
export interface RunLogRow {
  id: number; // stable, monotonic per mounted run
  ev: LogEvent;
}
export interface RunLog {
  rows: RunLogRow[];
  state: RunStreamState;
  /** rows dropped from the front by the 400-row cap (disclosed in the UI) */
  dropped: number;
}

function cap(rows: LogEvent[]): LogEvent[] {
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
}

// synthesize the classified log for a FINISHED run from its captured output
// (paintFinished parity, incl. the "(no captured output)" placeholder row).
export function finishedRows(run: Run): LogEvent[] {
  const out: LogEvent[] = [];
  const output = run.output || "";
  if (!output.trim()) out.push({ type: "narrate", label: "log", text: "(no captured output)" });
  else
    output.split("\n").forEach((line) => {
      if (line.trim()) classifyLine(line).forEach((e) => out.push(e));
    });
  out.push({
    type: "done",
    label: "run-complete",
    text: (run.status || "ended") + (run.exit_code != null ? " · exit " + run.exit_code : ""),
  });
  return out;
}

export function useRunLog(run: Run | null): RunLog {
  const rid = run ? run.run_id || run.id || null : null;
  const agentId = run ? run.agent_id || run.agent || null : null;
  const live = !!run && run.status === "running";
  const [log, setLog] = useState<RunLog>({ rows: [], state: "idle", dropped: 0 });
  // latest run object without re-keying the effect — the 3s poll hands us a
  // fresh object each tick, but the stream must only restart when the run
  // identity or liveness actually changes.
  const runRef = useRef<Run | null>(run);
  runRef.current = run;
  const nextId = useRef(0);

  useEffect(() => {
    nextId.current = 0;
    const toRows = (evts: LogEvent[]): RunLogRow[] => evts.map((ev) => ({ id: nextId.current++, ev }));
    setLog({ rows: [], state: rid ? "connecting" : "idle", dropped: 0 });
    if (!rid) return;

    if (!live) {
      const r = runRef.current;
      if (r) {
        const all = finishedRows(r);
        const kept = cap(all);
        setLog({ rows: toRows(kept), state: "finished", dropped: all.length - kept.length });
      }
      return;
    }

    // live: one EventSource, reopened on stream_timeout, replay-guarded by seq.
    if (typeof EventSource === "undefined" || !agentId) {
      setLog({ rows: [], state: "unsupported", dropped: 0 });
      return;
    }
    let es: EventSource | null = null;
    let maxSeq = 0;
    let stopped = false;
    const append = (evts: LogEvent[], state?: RunStreamState) => {
      if (!evts.length && !state) return;
      setLog((prev) => {
        const merged = prev.rows.concat(toRows(evts));
        const over = Math.max(0, merged.length - MAX_ROWS);
        return { rows: over ? merged.slice(over) : merged, state: state ?? prev.state, dropped: prev.dropped + over };
      });
    };
    const setState = (state: RunStreamState) => setLog((prev) => (prev.state === state ? prev : { ...prev, state }));
    const open = () => {
      if (stopped) return;
      try {
        es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(rid) + "/stream");
      } catch {
        setState("unsupported");
        return;
      }
      es.onopen = () => {
        if (!stopped) setState("live");
      };
      es.onerror = () => {
        // the browser retries on its own; never claim "live" while it does
        if (!stopped) setState("reconnecting");
      };
      es.onmessage = (ev) => {
        let d: { done?: boolean; status?: string; seq?: number; line?: string };
        try {
          d = JSON.parse(ev.data) as typeof d;
        } catch {
          return;
        }
        if (d && d.done) {
          if (es) {
            try {
              es.close();
            } catch {
              /* already closed */
            }
            es = null;
          }
          if (d.status === "stream_timeout" && !stopped) {
            open(); // reconnectable 30-min server cap; maxSeq guard drops the replay
            return;
          }
          append([{ type: "done", label: "run-complete", text: String(d.status || "ended") }], "ended");
          return;
        }
        if (d && typeof d.seq === "number" && typeof d.line === "string") {
          if (d.seq <= maxSeq) return; // monotonic — drops reconnect replay
          maxSeq = d.seq;
          append(classifyLine(d.line), "live");
        }
      };
    };
    open();
    return () => {
      stopped = true;
      if (es) {
        try {
          es.close();
        } catch {
          /* already closed */
        }
        es = null;
      }
    };
  }, [rid, agentId, live]);

  return log;
}

export function useRunStream(run: Run | null): LogEvent[] {
  const { rows } = useRunLog(run);
  return useMemo(() => rows.map((r) => r.ev), [rows]);
}
