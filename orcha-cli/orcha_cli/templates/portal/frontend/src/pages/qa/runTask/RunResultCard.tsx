/**
 * The top of a run task: what ran and how it ended, with every way into the detail. While the run
 * goes it says what is happening now, with the device and the activity one click away. It reads as
 * one clean task: plain words, no ids, no raw text.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Avatar, ButtonLink, Chip, Skeleton } from "../../../components/primitives";
import { Icon } from "../../../components/ui";
import { relTime } from "../../../lib/format";
import { useRequestsChanged } from "../../../state/qaRequestBus";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { Task } from "../../../types";
import { QaStatus, TaskLink, qaHref, useLoad } from "../parts";
import { getTaskQa } from "../qaApi";
import { minutesWord, plural, severityTone, severityWord } from "../qaWords";
import { normalizeRequest } from "../requests/api";
import { runPageHref, sessionHref } from "../requests/links";
import { lineTime } from "../run/runLog";
import { useRunLog } from "../run/useRunLog";
import { FINISHED_ALONE_WORD, type FinishDecision } from "./finishing";
import { runTaskModel, type RunRow, type RunTaskModel } from "./model";
import "../qa.css";
import "./runTask.css";

const LIVE_POLL_MS = 5_000;
const LIVE_LINES = 4;

/** Who did it: their avatar and name, a way to their page. */
export function RunAgent({ alias }: { alias: string }) {
  const { snap } = useSnapshot();
  const a = snap?.agents.find((x) => x.alias === alias);
  return (
    <Link className="rr-agent" to={`/agents?agent=${encodeURIComponent(alias)}`} data-run-agent={alias}>
      <Avatar alias={alias} kind={a?.kind || "ai"} size={20} decorative />
      <span>{alias}</span>
    </Link>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="rr-fact">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Rows({ rows, label, href }: { rows: readonly RunRow[]; label: string; href?: (r: RunRow) => string | null }) {
  return (
    <ul className="qa-plain rr-rows" aria-label={label}>
      {rows.map((r) => {
        const to = href?.(r);
        return (
          <li key={r.key} className="rr-row">
            <QaStatus glyph={r.glyph} word={r.word} size={12} />
            {to ? <Link className="rr-row-t" to={to}>{r.name}</Link> : <span className="rr-row-t">{r.name}</span>}
            <span className="qa-muted">{r.word}</span>
            {r.note ? <span className="qa-muted rr-note">{r.note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rr-group">
      <div className="qa-taskqa-k">{title}</div>
      {children}
    </div>
  );
}

/** Finished with no person: says so, why that was allowed, and who allowed it. */
export function FinishedAlone({ d }: { d: FinishDecision }) {
  return (
    <p className="rr-finished" data-finished-alone>
      <Icon name="check" cls="v2-ico" />
      <span>
        <b>{FINISHED_ALONE_WORD}.</b> Every line was proven, with no risk flags and no serious findings.
        {d.enabled_by ? <> Turned on by {d.enabled_by}{d.enabled_at ? `, ${relTime(d.enabled_at)}` : ""}.</> : null}
      </span>
    </p>
  );
}

/** What is going on now: the run's own line, its last few steps, the device and the activity. */
function LiveBlock({ m, taskId }: { m: RunTaskModel; taskId: string }) {
  const log = useRunLog({ taskId, sessionId: m.session });
  const sid = log.sessionId ?? m.session;
  const platform = log.platform ?? m.platform;
  const lines = log.entries.slice(-LIVE_LINES);
  return (
    <div className="rr-live" data-run-live>
      <p className="rr-now" aria-live="polite">{log.now?.text ?? (m.phase === "waiting" ? "Waiting for its agent to start." : "Working.")}</p>
      {lines.length ? (
        <ol className="qa-plain rr-activity" aria-label="Latest activity">
          {lines.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at}>{lineTime(e.at)}</time>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {sid ? (
        <div className="rr-links">
          {m.drafting ? null : <ButtonLink size="sm" icon="live" to={runPageHref(sid, platform)}>Watch the device</ButtonLink>}
          <ButtonLink size="sm" variant={m.drafting ? "secondary" : "ghost"} to={sessionHref(sid, platform)}>Open the run</ButtonLink>
        </div>
      ) : null}
    </div>
  );
}

function Finished({ m, taskId }: { m: RunTaskModel; taskId: string }) {
  const failing = m.scenarios.filter((r) => r.word !== "Pass").length;
  const findingHref = (id: string | null | undefined) => sessionHref(id ?? m.session ?? "", m.platform);
  return (
    <>
      {m.summary ? <p className="rr-summary">{m.summary}</p> : null}
      {m.reason && m.reason !== m.summary ? <p className="rr-summary">{m.reason}</p> : null}
      {m.finish?.finished ? <FinishedAlone d={m.finish} /> : null}
      {m.scenarios.length ? (
        <Group title={`${plural(m.scenarios.length, "scenario")}${failing ? `, ${failing} did not pass` : ""}`}>
          <Rows rows={m.scenarios} label="Scenarios" href={(r) => (r.scenarioId ? qaHref({ view: "scenarios", scenario: r.scenarioId }) : null)} />
        </Group>
      ) : null}
      {m.lines.length ? <Group title="Lines checked"><Rows rows={m.lines} label="Lines checked" /></Group> : null}
      {m.findings.length ? (
        <Group title={plural(m.findings.length, "finding")}>
          <ul className="qa-plain rr-rows" aria-label="Findings">
            {m.findings.map((f) => (
              <li key={f.id} className="rr-row">
                <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip>
                <Link className="rr-row-t" to={findingHref(f.session_id)}>{f.title}</Link>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
      {m.drafts.length ? (
        <Group title={plural(m.drafts.length, "drafted scenario")}>
          <ul className="qa-plain rr-rows" aria-label="Drafted scenarios">
            {m.drafts.map((d) => (
              <li key={d.id} className="rr-row">
                <Link className="rr-row-t" to={qaHref({ view: "scenarios", scenario: d.id })}>{d.name}</Link>
                <span className="qa-muted">{d.toReview ? "To review" : "Reviewed"}</span>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
      {m.session ? (
        <div className="rr-links">
          <ButtonLink size="sm" to={sessionHref(m.session, m.platform)}>Open the run</ButtonLink>
          {m.drafting ? null : <ButtonLink size="sm" variant="ghost" icon="play" to={runPageHref(m.session, m.platform)}>Replay</ButtonLink>}
          <ButtonLink size="sm" variant="ghost" to={m.workerRun ?? `/tasks?task=${encodeURIComponent(taskId)}&tab=runs`}>What the agent did</ButtonLink>
        </div>
      ) : null}
    </>
  );
}

export function RunResultCard({ task }: { task: Task }) {
  const changed = useRequestsChanged();
  const [tick, setTick] = useState(0);
  const res = useLoad((s) => getTaskQa(task.id, s), [task.id], tick + changed);
  const m = useMemo(() => runTaskModel(res.data), [res.data]);
  // The work this run checks, when a task was handed to it. A workflow step checks itself.
  const source = useMemo(() => (res.data?.requests ?? []).map(normalizeRequest)
    .find((r) => r.qa_task_id === task.id && r.source_task_id && r.source_task_id !== task.id) ?? null, [res.data, task.id]);
  const live = !m || m.phase === "waiting" || m.phase === "running";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live]);
  if (res.status === 404) return null;
  // Nothing is known yet: never say a finished run is waiting.
  if (!res.data && !res.error) return <section className="rr" aria-label="Run result" aria-busy="true"><Skeleton lines={2} label="Loading the run" /></section>;
  const phase = m?.phase ?? "waiting";
  const going = phase === "waiting" || phase === "running";
  const facts = m ? [
    m.device ? <Fact key="device" k="Device">{m.device}</Fact> : null,
    m.build ? <Fact key="build" k="Build">{m.build}</Fact> : null,
    m.screens != null ? <Fact key="screens" k="Screens reached">{m.screens}</Fact> : null,
    m.minutes != null && !going ? <Fact key="time" k="Took">{m.minutes < 1 ? "Under a minute" : minutesWord(m.minutes)}</Fact> : null,
  ].filter(Boolean) : [];
  return (
    <section className="rr" aria-label="Run result" data-run-result={phase}>
      <header className="rr-h">
        <QaStatus glyph={m?.outcome.glyph ?? "pending"} word={m?.outcome.word ?? "Waiting"} show size={14} />
        <span className="rr-what">{m?.what ?? "Quality run"}</span>
        <span className="v2-grow" />
        {m?.agent ? <RunAgent alias={m.agent} /> : null}
      </header>
      {source ? <p className="rr-for">Checks <TaskLink id={source.source_task_id!} title={source.source_task_title} /></p> : null}
      {going
        ? (m ? <LiveBlock m={m} taskId={task.id} /> : <p className="rr-now">Waiting for its agent to start.</p>)
        : m ? <Finished m={m} taskId={task.id} /> : null}
      {facts.length ? <dl className="rr-facts">{facts}</dl> : null}
    </section>
  );
}
