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
 */
import { useEffect, useRef, useState } from "react";
import { classifyLine, type LogEvent } from "../lib/classify";
import type { Run } from "../types";

const MAX_ROWS = 400; // appendLine's unbounded-growth cap

function cap(rows: LogEvent[]): LogEvent[] {
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
}

// synthesize the classified log for a FINISHED run from its captured output
// (paintFinished parity, incl. the "(no captured output)" placeholder row).
function finishedRows(run: Run): LogEvent[] {
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
  return cap(out);
}

export function useRunStream(run: Run | null): LogEvent[] {
  const rid = run ? run.run_id || run.id || null : null;
  const agentId = run ? run.agent_id || run.agent || null : null;
  const live = !!run && run.status === "running";
  const [lines, setLines] = useState<LogEvent[]>([]);
  // latest run object without re-keying the effect — the 3s poll hands us a
  // fresh object each tick, but the stream must only restart when the run
  // identity or liveness actually changes.
  const runRef = useRef<Run | null>(run);
  runRef.current = run;

  useEffect(() => {
    setLines([]);
    if (!rid) return;

    if (!live) {
      const r = runRef.current;
      if (r) setLines(finishedRows(r));
      return;
    }

    // live: one EventSource, reopened on stream_timeout, replay-guarded by seq.
    if (typeof EventSource === "undefined" || !agentId) return;
    let es: EventSource | null = null;
    let maxSeq = 0;
    let stopped = false;
    const append = (evts: LogEvent[]) => {
      if (!evts.length) return;
      setLines((prev) => cap(prev.concat(evts)));
    };
    const open = () => {
      if (stopped) return;
      try {
        es = new EventSource("/api/agents/" + encodeURIComponent(agentId) + "/runs/" + encodeURIComponent(rid) + "/stream");
      } catch {
        return;
      }
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
          append([{ type: "done", label: "run-complete", text: String(d.status || "ended") }]);
          return;
        }
        if (d && typeof d.seq === "number" && typeof d.line === "string") {
          if (d.seq <= maxSeq) return; // monotonic — drops reconnect replay
          maxSeq = d.seq;
          append(classifyLine(d.line));
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

  return lines;
}
