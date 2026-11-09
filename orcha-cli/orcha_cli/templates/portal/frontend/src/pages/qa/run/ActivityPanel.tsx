/**
 * What is happening, what happened and why it waits, always in view: the headline, the actions that
 * help a run stuck on a device, and the run's timeline, newest at the bottom. It follows new lines
 * until the person scrolls up. Old lines stay after the run.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/primitives";
import type { QaAuthority } from "../authority";
import { Link, useToast } from "../map/kit";
import { AlertTriangle, CircleCheck, Clock, OctagonAlert } from "../map/kit/icons";
import { blockedRequestHref } from "../onboarding/live-pass";
import { errText } from "../parts";
import { tailJump, tailOnScroll, tailStart, tailUnseen, type TailState } from "../runs/theater/theater-model";
import { stopSession } from "../sessions/api";
import { useNow } from "../sessions/detail/phase-timeline";
import { behindWords, deviceWord, headline, lineTime, sendToDevice, type RunLogEntry, type RunLogLevel } from "./runLog";
import { useRunLog, type RunLog } from "./useRunLog";
import "./run.css";

const RunLogContext = createContext<RunLog | null>(null);

/** The run's timeline for everything under it: the panel, and the device with no screen yet. */
export function RunWatch({ sessionId, taskId, children }: { sessionId?: string | null; taskId?: string | null; children: ReactNode }) {
  const log = useRunLog({ sessionId, taskId });
  return <RunLogContext.Provider value={log}>{children}</RunLogContext.Provider>;
}

export const RunLogProvider = RunLogContext.Provider;

/** What the run is doing, in words, for a place that has nothing better to show. */
export function useRunWords(): string | null {
  return useContext(RunLogContext)?.now?.text ?? null;
}

const LEVEL_ICON: Partial<Record<RunLogLevel, typeof Clock>> = { wait: Clock, warn: AlertTriangle, error: OctagonAlert, done: CircleCheck };
const LEVEL_WORD: Partial<Record<RunLogLevel, string>> = { wait: "Waiting", warn: "Warning", error: "Error", done: "Done" };

function LevelMark({ level }: { level: RunLogLevel }) {
  const Icon = LEVEL_ICON[level];
  if (!Icon) return <span className="qa-activity-dot" aria-hidden="true" />;
  return <Icon className="qa-activity-ico" strokeWidth={2} aria-label={LEVEL_WORD[level]} />;
}

function Line({ e }: { e: RunLogEntry }) {
  return (
    <li className="qa-activity-line" data-level={e.level} data-kind={e.kind}>
      <time className="qa-activity-time" dateTime={e.at}>{lineTime(e.at)}</time>
      <span className="qa-activity-mark"><LevelMark level={e.level} /></span>
      <span className="qa-activity-text">
        {e.text}
        {e.detail ? <span className="qa-activity-detail">{e.detail}</span> : null}
      </span>
    </li>
  );
}

/** The two things a person can do about a held device. */
function DeviceActions({ log, auth }: { log: RunLog; auth: QaAuthority }) {
  const now = log.now;
  const { toast } = useToast();
  const [busy, setBusy] = useState<"use" | "cancel" | null>(null);
  const sid = now?.session_id;
  if (!now || !sid || now.state !== "waiting" || !auth.can) return null;
  const act = async (which: "use" | "cancel", call: () => Promise<unknown>, title: string) => {
    setBusy(which);
    try {
      await call();
      log.refresh();
    } catch (err) {
      toast({ title, description: errText(err), variant: "error" });
    } finally {
      setBusy(null);
    }
  };
  const actor = auth.human?.id ?? null;
  const free = now.free_device;
  return (
    <div className="qa-activity-actions" data-run-actions>
      {free ? (
        <Button size="sm" busy={busy === "use"} disabled={busy != null} onClick={() => void act("use", () => sendToDevice(sid, free, actor), "Could not change the device")} data-run-use-device={free}>
          Use {deviceWord(free)}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" busy={busy === "cancel"} disabled={busy != null} onClick={() => void act("cancel", () => stopSession(sid, actor), "Could not cancel the run")} data-run-cancel>
        Cancel
      </Button>
    </div>
  );
}

/** The line a person reads first. `fallback`: what is known before the first read lands. */
export function RunHeadline({ log, auth, fallback, className }: { log: RunLog; auth: QaAuthority; fallback?: string | null; className?: string }) {
  const now = log.now;
  const ticks = useNow(log.live);
  const words = now ? headline(now, ticks) : fallback ?? "Reading what this run is doing";
  return (
    <div className={"qa-activity-now" + (className ? " " + className : "")} data-level={now?.level ?? "info"} data-run-now={now?.state ?? "loading"}>
      <p className="qa-activity-head" role="status" data-run-headline>
        {now ? <LevelMark level={now.level} /> : null}
        <span>{words}</span>
      </p>
      {now?.request_id ? <Link href={blockedRequestHref(now.request_id)} className="qa-activity-link" data-run-request>Open the request</Link> : null}
      <DeviceActions log={log} auth={auth} />
    </div>
  );
}

/** The timeline. */
export function ActivityLog({ log }: { log: RunLog }) {
  const box = useRef<HTMLOListElement>(null);
  const [tail, setTail] = useState<TailState>(() => tailStart());
  const count = log.entries.length;
  const ticks = useNow(log.live);
  const behind = behindWords(log.lastOkAt, ticks);

  useLayoutEffect(() => {
    if (tail.following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count, tail.following, log.entries]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setTail((t) => tailOnScroll(t, atBottom, count));
  };
  const unseen = tailUnseen(tail, count);
  return (
    <div className="qa-activity-body">
      {behind ? <p className="qa-activity-behind" role="status" data-run-behind>{behind}</p> : null}
      {count === 0 ? (
        <p className="qa-activity-empty">{log.lastOkAt ? "Nothing has happened yet." : "Reading what this run is doing."}</p>
      ) : (
        <ol ref={box} className="qa-activity-log" onScroll={onScroll} aria-label="What happened" data-activity-lines>
          {log.truncated ? <li className="qa-activity-older">Older lines are left out.</li> : null}
          {log.entries.map((e) => <Line key={e.id} e={e} />)}
        </ol>
      )}
      {!tail.following ? (
        <button type="button" className="qa-activity-jump" onClick={() => setTail(tailJump(count))} data-activity-jump>
          {unseen ? `${unseen} new ${unseen === 1 ? "line" : "lines"}` : "Jump to latest"}
        </button>
      ) : null}
    </div>
  );
}

/** Headline and timeline in one panel. `fill`: it takes its column's height. `counters`: figures that keep moving. */
export function ActivityPanel({ log, auth, fallback, fill = false, counters }: { log?: RunLog; auth: QaAuthority; fallback?: string | null; fill?: boolean; counters?: string }) {
  const held = useContext(RunLogContext);
  const shown = log ?? held;
  if (!shown) return null;
  return (
    <section className={"qa-activity" + (fill ? " is-fill" : "")} aria-label="Activity" data-activity-panel>
      <div className="qa-activity-top">
        <h2 className="qa-activity-t">Activity</h2>
        {counters ? <span className="qa-activity-count">{counters}</span> : null}
      </div>
      <RunHeadline log={shown} auth={auth} fallback={fallback} />
      <ActivityLog log={shown} />
    </section>
  );
}
