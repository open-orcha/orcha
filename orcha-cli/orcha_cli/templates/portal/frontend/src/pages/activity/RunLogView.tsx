/**
 * RunLogView — the Activity inspector's run log (Agent E).
 *
 * Built on hooks/useRunLog (the shared per-run SSE engine + classifyLine), so
 * the event classification is exactly the one the agent Runs tab and the task
 * Runs tab use; ./logRow only shapes each classified event for display (short
 * kind label, one-line summary, key/value details — never raw JSON). Rows
 * carry stable ids, so a streamed append never re-creates existing rows: text
 * selection and expanded details survive updates. Auto-follow only while the
 * reader is at the bottom; after a manual scroll a docked "Jump to latest"
 * pill appears (hooks/useLogFollow) and the log reserves room for it so it
 * never covers a line. The stream state is reported honestly — "Live" only
 * while the EventSource is actually open.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../components/primitives";
import { useLogFollow } from "../../hooks/useLogFollow";
import { useRunLog, type RunStreamState } from "../../hooks/useRunStream";
import type { Run } from "../../types";
import { logRowView, type LogRowView } from "./logRow";
import type { RunBucket } from "./runModel";

const STATE_TEXT: Record<RunStreamState, { text: string; tone: "info" | "warn" | "neutral" | "ok" }> = {
  idle: { text: "No run", tone: "neutral" },
  connecting: { text: "Connecting to stream…", tone: "neutral" },
  live: { text: "Live stream", tone: "info" },
  reconnecting: { text: "Reconnecting…", tone: "warn" },
  ended: { text: "Stream ended", tone: "neutral" },
  finished: { text: "Captured output", tone: "neutral" },
  unsupported: { text: "Live stream unavailable — output appears when the run finishes", tone: "warn" },
};

function copyText(s: string) {
  try {
    void navigator.clipboard?.writeText(s);
  } catch {
    /* clipboard unavailable: the text stays selectable */
  }
}

function RowDetails({ v, id }: { v: LogRowView; id: string }) {
  const copy = v.body ?? v.raw ?? (v.fields ? v.fields.map(([k, val]) => k + ": " + val).join("\n") : "");
  return (
    <div className="act-det" id={id}>
      <IconButton icon="copy" label="Copy details" size="sm" className="act-det-copy" onClick={() => copyText(copy)} />
      {v.fields ? (
        <dl className="act-det-kv">
          {v.fields.map(([k, val], i) => (
            <div key={k + i}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {v.body ? <pre className="act-det-pre">{v.body}</pre> : null}
      {v.raw ? (
        <>
          <div className="act-det-cap">Raw payload</div>
          <pre className="act-det-pre">{v.raw}</pre>
        </>
      ) : null}
    </div>
  );
}

export function RunLogView({ run, outcome }: { run: Run; outcome?: { bucket: RunBucket; stoppedByHuman?: boolean } | null }) {
  const { rows, state, dropped } = useRunLog(run);
  const ref = useRef<HTMLDivElement | null>(null);
  const follow = useLogFollow(ref);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const last = rows.length ? rows[rows.length - 1].id : -1;

  // after each append: pin if following, else flag unseen lines (never moves the view)
  useLayoutEffect(() => {
    if (last >= 0) follow.onContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const st = STATE_TEXT[state];
  const rid = String(run.run_id || run.id || "r");
  return (
    <div className="act-log">
      <div className="act-log-h">
        <span className={"act-stream act-tone-" + st.tone}>
          <span className="act-stream-dot" aria-hidden="true" />
          {st.text}
        </span>
        {rows.length ? <span className="act-log-count">{rows.length} line{rows.length === 1 ? "" : "s"}</span> : null}
        {dropped > 0 ? <span className="act-log-count">· {dropped} earlier not shown (400-line window)</span> : null}
      </div>
      <div className="log-follow act-log-follow">
        <div
          className={"act-log-b" + (follow.away ? " is-away" : "")}
          ref={ref}
          onScroll={follow.onScroll}
          role="log"
          aria-live="off"
          aria-label="Run log"
          tabIndex={0}
        >
          {rows.map(({ id, ev }) => {
            const v = logRowView(ev, outcome ?? null);
            const has = !!(v.fields || v.body || v.raw);
            const isOpen = open.has(id);
            const detId = "act-det-" + rid + "-" + id;
            return (
              <div key={id} className={"act-ln act-ln-" + (ev.type || "narrate")} data-type={ev.type}>
                <span className={"act-ln-k act-tone-" + v.tone}>{v.kind}</span>
                <div className="act-ln-body">
                  <div className="act-ln-row">
                    <span className="act-ln-t">{v.text || <span className="act-ln-none">(no text)</span>}</span>
                    {has ? (
                      <button
                        type="button"
                        className="act-ln-more"
                        aria-expanded={isOpen}
                        aria-controls={detId}
                        onClick={() => toggle(id)}
                      >
                        <svg viewBox="0 0 12 12" aria-hidden="true" className={isOpen ? "is-open" : ""}>
                          <path d="M4.5 3 7.5 6l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Details
                      </button>
                    ) : null}
                  </div>
                  {has && isOpen ? <RowDetails v={v} id={detId} /> : null}
                </div>
              </div>
            );
          })}
          {!rows.length && state !== "unsupported" ? (
            <div className="act-log-empty">{state === "connecting" || state === "live" ? "Waiting for the first line…" : "No output was captured for this run."}</div>
          ) : null}
        </div>
        {follow.away && (
          <div className="act-jump">
            <Button size="sm" variant="secondary" onClick={follow.jump}>
              {follow.unseen ? "New lines · Jump to latest" : "Jump to latest"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
