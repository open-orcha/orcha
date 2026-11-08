/**
 * The line above a run's device, for what the theater cannot say: it waits for a device (never a
 * failure), its agent is blocked on a person, or it came from onboarding and is finished, where
 * Continue goes back to a step that has moved on.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getJSON } from "../../../api/client";
import { Button } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { Link } from "../map/kit";
import { blockedRequestHref } from "../onboarding/live-pass";
import type { QaSession } from "../qaApi";
import { startPollLoop } from "../runs/live/poll-loop";
import { queuedWords, type QueuePlace } from "../sessions/detail/model";
import { fromOnboarding } from "./runFlow";
import "./run.css";

const BLOCKED_POLL_MS = 8_000;

interface OpenRequest { id: string; created_at: string; status: string; originating_task_id?: string | null; requester_id?: string | null; payload?: unknown }

/** The newest open question this run's task asked. The list is read here, not from the page's snapshot:
 * a blocked run must say so while a person watches it, and the snapshot can be minutes old. */
function useBlockedOn(cid: string | null, taskId: string | null, on: boolean): OpenRequest | null {
  const [open, setOpen] = useState<OpenRequest | null>(null);
  useEffect(() => {
    setOpen(null);
    if (!cid || !taskId || !on) return;
    const loop = startPollLoop({
      timeoutMs: 20_000,
      retryMs: BLOCKED_POLL_MS,
      hiddenMs: BLOCKED_POLL_MS * 3,
      run: async (signal) => {
        const r = await getJSON<{ requests?: OpenRequest[] }>(`/api/containers/${encodeURIComponent(cid)}/requests?status=open`, signal);
        if (signal.aborted) return BLOCKED_POLL_MS;
        const rows = (r?.requests ?? []).filter((x) => x.originating_task_id === taskId && x.status === "open");
        setOpen(rows.sort((x, y) => y.created_at.localeCompare(x.created_at))[0] ?? null);
        return BLOCKED_POLL_MS;
      },
    });
    return () => loop.stop();
  }, [cid, taskId, on]);
  return open;
}

/** The newest session of a task, when it isn't `session`: an agent that retried after a failed start
 *  works on under a new session, and the page must go with it instead of saying the run has ended. */
function useRetriedAs(cid: string | null | undefined, session: QaSession, running: boolean): string | null {
  const [next, setNext] = useState<string | null>(null);
  const taskId = session.task_id;
  useEffect(() => {
    if (running || !cid || !taskId) return;
    let live = true;
    const look = () => {
      void getJSON<{ sessions: { id: string; started_at: string | null }[] }>(
        `/api/containers/${encodeURIComponent(cid)}/qa/sessions?task_id=${encodeURIComponent(taskId)}&limit=5`,
      ).then((r) => {
        const newer = (r.sessions ?? []).find((s) => s.id !== session.id && (s.started_at ?? "") > (session.started_at ?? ""));
        if (live && newer) setNext(newer.id);
      }).catch(() => undefined);
    };
    look();
    const t = window.setInterval(look, BLOCKED_POLL_MS);
    return () => { live = false; window.clearInterval(t); };
  }, [cid, taskId, session.id, session.started_at, running]);
  return next;
}

export function RunStateLine({ session, from, onContinue }: {
  /** `GET .../run` keeps a queued session's place on the session itself. */
  session: QaSession & { queue?: QueuePlace | null };
  from: string | null;
  onContinue: () => void;
}) {
  const { snap, cid } = useSnapshot();
  const running = session.status === "running";
  const blocked = useBlockedOn(cid, session.task_id, running);
  const retriedAs = useRetriedAs(cid, session, running);
  const [, setParams] = useSearchParams();
  useEffect(() => {
    if (!retriedAs) return;
    setParams((p) => { p.set("session", retriedAs); return p; }, { replace: true });
  }, [retriedAs, setParams]);
  if (retriedAs) {
    return (
      <div className="qa-runline" role="status" data-run-line="retried">
        <p className="qa-runline-t">The agent started again. <span className="qa-runline-b">Going to the new run.</span></p>
      </div>
    );
  }
  if (running && blocked) {
    const who = (snap?.agents ?? []).find((a) => a.id === blocked.requester_id)?.alias ?? session.agent_alias ?? "The agent";
    const text = typeof blocked.payload === "string" ? blocked.payload.split(/\s+/).join(" ").slice(0, 160) : "";
    return (
      <div className="qa-runline" role="status" data-run-line="blocked">
        <p className="qa-runline-t">{who} is waiting for an answer{text ? `: ${text}` : ""}</p>
        <Link href={blockedRequestHref(blocked.id)} data-run-request>Open the request</Link>
      </div>
    );
  }
  if (running && session.queue) {
    const words = queuedWords(session.queue);
    return (
      <div className="qa-runline" role="status" data-run-line="waiting">
        <p className="qa-runline-t">{words.title} <span className="qa-runline-b">{words.body}</span></p>
      </div>
    );
  }
  if (!running && fromOnboarding(from)) {
    return (
      <div className="qa-runline" data-run-line="finished">
        <p className="qa-runline-t">This run has ended.</p>
        <Button size="sm" variant="primary" onClick={onContinue} data-run-continue>Continue</Button>
      </div>
    );
  }
  return null;
}
