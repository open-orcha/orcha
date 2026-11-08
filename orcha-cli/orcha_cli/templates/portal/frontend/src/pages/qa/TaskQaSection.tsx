/**
 * The task's QA block (GET /api/tasks/{tid}/qa): the requests sent to QA for this task with
 * their live status, which definition-of-done lines QA proved, the QA sessions an agent ran,
 * what it found, the scenarios it drafted and the check verdicts — each linking into Quality.
 * With no QA data it shows only "Send to Quality when finished", on a task that can still go to
 * Quality, in a project with an app set; "Send to QA" also sits in the task's menu. Nothing else
 * changes for ordinary tasks.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Chip, Tooltip } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { qaAuthority } from "./authority";
import { getTaskQa, listTargets, taskQaIsEmpty, type Platform, type QaVerdict, type TaskQa } from "./qaApi";
import { useRequestsChanged } from "../../state/qaRequestBus";
import { normalizeRequest, type QaRequest } from "./requests/api";
import { requestHref, runPageHref } from "./requests/links";
import { isOpenRequest, linesTally, newestFirst, provedLines } from "./requests/model";
import { SendToQaDialog, type SendToQaTask } from "./requests/SendToQaDialog";
import { OnDoneRow } from "./requests/OnDoneControl";
import { ReportDownloads } from "./report/ReportDownloads";
import { readOnDone, type QaOnDone } from "./requests/on-done";
import { requestKindWord, requestStatusGlyph, requestStatusWord, requestTitle, roundWord } from "./requests/words";
import {
  findingStatusWord, platformWord, plural, scenarioStatusGlyph, scenarioStatusWord, sessionKindWord, sessionStatusGlyph, sessionStatusWord,
  severityTone, severityWord, verdictGlyph, verdictWord,
} from "./qaWords";
import { sessionTitle } from "./sessions/title";
import { FinishedAlone } from "./runTask/RunResultCard";
import { readFinishDecision } from "./runTask/finishing";
import { QaStatus, TaskLink, qaHref, useLoad } from "./parts";
import "./qa.css";

const plat = (p: Platform | string | null | undefined) => (p && p !== "ios" ? p : null);

/** Per scenario: "3 pass · 1 fail" from the task's verdicts. */
export function verdictTally(verdicts: QaVerdict[]): { scenario_id: string; name: string; tally: string; failed: boolean }[] {
  const by = new Map<string, QaVerdict[]>();
  for (const v of verdicts) by.set(v.scenario_id, [...(by.get(v.scenario_id) ?? []), v]);
  return [...by.entries()].map(([id, vs]) => {
    const n: Record<string, number> = {};
    for (const v of vs) n[v.verdict] = (n[v.verdict] ?? 0) + 1;
    const tally = (["pass", "fail", "blocked", "inconclusive"] as const).filter((k) => n[k]).map((k) => `${n[k]} ${verdictWord(k).toLowerCase()}`).join(" · ");
    return { scenario_id: id, name: vs.find((v) => v.scenario_name)?.scenario_name || "Scenario", tally, failed: !!n.fail };
  });
}

const REQUEST_POLL_MS = 5_000;

/** A request's row: live status, what it asked, its result so far, and the device while it runs. */
function RequestRow({ r }: { r: QaRequest }) {
  const facts = [requestKindWord(r.kind), r.platform ? platformWord(r.platform) : null, r.round > 1 ? roundWord(r.round, r.max_rounds) : null, linesTally(r)].filter(Boolean).join(" · ");
  return (
    <li className="qa-taskqa-row" data-task-request={r.id} data-status={r.status}>
      <QaStatus glyph={requestStatusGlyph(r.status)} word={requestStatusWord(r.status, r.kind)} size={12} />
      <Link className="qa-taskqa-t" to={requestHref(r)}>{requestTitle(r)}</Link>
      <span className="qa-muted">{requestStatusWord(r.status, r.kind)} · {facts}</span>
      {r.status === "running" && r.session_id ? <Link className="qa-tasklink" to={runPageHref(r.session_id, r.platform)}>Watch</Link> : null}
    </li>
  );
}

/** The definition-of-done lines QA gave a verdict on, each with its proof. */
function ProvedLines({ rows }: { rows: QaRequest[] }) {
  const lines = provedLines(rows);
  if (!lines.length) return null;
  return (
    <div className="qa-taskqa-group">
      <div className="qa-taskqa-k">Definition of done</div>
      <ul className="qa-plain qa-taskqa-list" aria-label="Definition of done lines QA checked">
        {lines.map((l) => (
          <li key={l.index + ":" + l.request.id} className="qa-taskqa-line" data-proved={l.verdict === "pass" ? "true" : "false"}>
            <span className="qa-taskqa-row">
              <QaStatus glyph={verdictGlyph(l.verdict)} word={verdictWord(l.verdict)} size={12} />
              <span className="qa-taskqa-t" title={l.text}>{l.text}</span>
              <span className="qa-muted">{l.verdict === "pass" ? "QA proved it" : verdictWord(l.verdict)}</span>
            </span>
            {l.note ? <span className="qa-muted qa-req-note">{l.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Statuses after which "when finished" has nothing left to wait for. */
const FINISHED = ["completed", "cancelled", "needs_verification"];

export function TaskQaSection({ taskId, task }: { taskId: string; task?: SendToQaTask }) {
  const auth = qaAuthority(useActingAuthority());
  const { cid } = useSnapshot();
  const [onDone, setOnDone] = useState<{ value: QaOnDone | null } | null>(null);
  const changed = useRequestsChanged();
  const [tick, setTick] = useState(0);
  const [sending, setSending] = useState(false);
  const res = useLoad((s) => getTaskQa(taskId, s), [taskId], tick + changed);
  const requests = useMemo(() => newestFirst((res.data?.requests ?? []).map(normalizeRequest)), [res.data]);
  const live = requests.some(isOpenRequest);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), REQUEST_POLL_MS);
    return () => clearInterval(t);
  }, [live]);
  // A project with no app set has no Quality to send to: its tasks stay as they were.
  const targets = useLoad(cid && task ? (s) => listTargets(cid, s) : null, [cid, !!task]);
  const hasApp = (targets.data ?? []).some((t) => !!t.app_id);
  const q: TaskQa | null = res.data;
  // The QA task itself lists the request it serves; only the work it tests goes to QA.
  const canSend = !!task && !requests.some((r) => r.qa_task_id === taskId);
  const toggle = !!cid && !!q && hasApp && canSend && !task!.workflow_id && !task!.is_root && !FINISHED.includes(task!.status ?? "");
  const onDoneValue = onDone ? onDone.value : readOnDone(q?.on_done);
  if (taskQaIsEmpty(q) && !toggle) return null;
  const qa = q!;
  const finish = readFinishDecision(qa.final_decision);
  const platformOf = (sid: string) => qa.sessions.find((s) => s.id === sid)?.platform ?? null;
  const tallies = verdictTally(qa.verdicts);
  return (
    <section className="td-block qa-taskqa" aria-label="QA">
      <div className="qa-taskqa-h">
        <div className="td-block-k">QA</div>
        {qa.sessions.some((x) => x.kind !== "draft") ? <ReportDownloads tid={taskId} /> : null}
        {canSend ? (auth.can
          ? <Button size="sm" variant="ghost" icon="phone" onClick={() => setSending(true)}>Send to QA</Button>
          : <Tooltip label={auth.reason || "Only a person can send work to QA from here"} placement="bottom"><Button size="sm" variant="ghost" icon="phone" disabled>Send to QA</Button></Tooltip>) : null}
      </div>
      {sending && canSend ? <SendToQaDialog task={task!} onClose={() => setSending(false)} /> : null}
      {toggle ? <OnDoneRow cid={cid!} taskId={taskId} value={onDoneValue} onChange={(value) => setOnDone({ value })} /> : null}
      {finish?.finished ? <FinishedAlone d={finish} /> : null}
      {requests.length ? (
        <ul className="qa-plain qa-taskqa-list" aria-label="QA requests">
          {requests.map((r) => <RequestRow key={r.id} r={r} />)}
        </ul>
      ) : null}
      <ProvedLines rows={requests} />
      {qa.sessions.length ? (
        <ul className="qa-plain qa-taskqa-list" aria-label="QA sessions">
          {qa.sessions.map((s) => (
            <li key={s.id}>
              <Link className="qa-taskqa-row" to={qaHref({ view: "sessions", platform: plat(s.platform), session: s.id })}>
                <QaStatus glyph={sessionStatusGlyph(s.status)} word={sessionStatusWord(s.status)} size={12} />
                <span className="qa-taskqa-t">{sessionTitle(s)}</span>
                <span className="qa-muted">{sessionKindWord(s.kind)} · {platformWord(s.platform)} · {relTime(s.started_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {qa.findings.length ? (
        <div className="qa-taskqa-group">
          <div className="qa-taskqa-k">{plural(qa.findings.length, "finding")}</div>
          <ul className="qa-plain qa-taskqa-list" aria-label="QA findings">
            {qa.findings.map((f) => (
              <li key={f.id} className="qa-taskqa-row">
                <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip>
                <Link className="qa-taskqa-t" to={qaHref({ view: "sessions", platform: plat(platformOf(f.session_id)), session: f.session_id })}>{f.title}</Link>
                {f.status === "filed" && f.filed_task_id ? <TaskLink id={f.filed_task_id} title={f.filed_task_title} className="qa-muted" /> : <span className="qa-muted">{findingStatusWord(f.status)}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {qa.scenarios.length ? (
        <div className="qa-taskqa-group">
          <div className="qa-taskqa-k">{plural(qa.scenarios.length, "drafted scenario")}</div>
          <ul className="qa-plain qa-taskqa-list" aria-label="Drafted scenarios">
            {qa.scenarios.map((sc) => (
              <li key={sc.id}>
                <Link className="qa-taskqa-row" to={qaHref({ view: "scenarios", platform: plat(sc.platform), scenario: sc.id })}>
                  <QaStatus glyph={scenarioStatusGlyph(sc.status)} word={scenarioStatusWord(sc.status)} size={12} />
                  <span className="qa-taskqa-t">{sc.name}</span>
                  <span className="qa-muted">{platformWord(sc.platform)} · {sc.status === "draft" ? "To review" : scenarioStatusWord(sc.status)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tallies.length ? (
        <div className="qa-taskqa-group">
          <div className="qa-taskqa-k">Checked</div>
          <ul className="qa-plain qa-taskqa-list" aria-label="Scenario checks">
            {tallies.map((t) => (
              <li key={t.scenario_id}>
                <Link className="qa-taskqa-row" to={qaHref({ view: "scenarios", scenario: t.scenario_id })}>
                  <QaStatus glyph={t.failed ? "failed" : "completed"} word={t.failed ? "Failed a check" : "Passed"} size={12} />
                  <span className="qa-taskqa-t">{t.name}</span>
                  <span className="qa-muted">{t.tally}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
