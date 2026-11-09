/**
 * The Triage inbox: findings still to judge, the ones that need a person, and what was decided
 * lately. `?finding=<id>` opens one with its diagnosis, where it came from and its actions. When
 * nothing waits, it says so: anything a run finds lands here first. It reads the project, the acting
 * person and the address itself, so it mounts with no props.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, ButtonLink, Chip, EmptyState, Inspector, List, ListGroup, Row, Skeleton, SplitPane } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import { useRequestsChanged } from "../../../state/qaRequestBus";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import { qaAuthority, type QaAuthority } from "../authority";
import { Filmstrip, FrameLightboxProvider } from "../Frames";
import { Kv, QaStatus, useLoad } from "../parts";
import type { QaFinding } from "../qaApi";
import { platformWord, severityTone, severityWord } from "../qaWords";
import { getRequest } from "../requests/api";
import { sessionHref, workflowStepHref } from "../requests/links";
import { isOpenRequest } from "../requests/model";
import { requestStatusGlyph, requestStatusWord, roundWord } from "../requests/words";
import { getTriageInbox, normalizeDiagnosis } from "./api";
import { FindingButtons } from "../sessions/detail/finding-actions";
import { FindingDiagnosis, useTriageRequest } from "./TriageActions";
import { classificationTone, classificationWord } from "./words";
import "../qa.css";
import "./triage.css";

const POLL_MS = 15_000;

function FindingRow({ f, selected, onOpen }: { f: QaFinding; selected: boolean; onOpen: () => void }) {
  const d = normalizeDiagnosis(f.triage);
  const turn = useTriageRequest(f.id);
  const open = !!turn && isOpenRequest(turn);
  return (
    <Row id={f.id} selected={selected} onActivate={onOpen} className="qa-tri-row">
      <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip>
      <span className="qa-req-title">{f.platform ? <span className="qa-tri-platform">{platformWord(f.platform)}</span> : null}{f.title}</span>
      {d ? <Chip size="sm" dot={classificationTone(d.classification)}>{classificationWord(d.classification)}</Chip> : open ? (
        <span className="qa-tri-turn" data-triage-turn={turn.status}>
          <QaStatus glyph={requestStatusGlyph(turn.status)} word={requestStatusWord(turn.status)} size={12} />
          {turn.source_workflow_id ? "In its workflow" : turn.status === "requested" ? "Queued" : "Running"}
        </span>
      ) : <span />}
      {d?.rate ? <span className="qa-diag-rate">{d.rate}</span> : <span />}
      <span className="qa-muted qa-req-at">{relTime(d?.at ?? f.created_at)}</span>
    </Row>
  );
}

function Group({ title, rows, selected, onOpen, note }: { title: string; rows: QaFinding[]; selected: string | null; onOpen: (id: string) => void; note: string }) {
  return (
    <section aria-label={title} data-triage-group={title}>
      <ListGroup id={"triage-" + title} title={title} count={rows.length}>
        {rows.length ? <List label={title}>{rows.map((f) => <FindingRow key={f.id} f={f} selected={selected === f.id} onOpen={() => onOpen(f.id)} />)}</List> : <p className="qa-muted qa-empty-line qa-tri-none">{note}</p>}
      </ListGroup>
    </section>
  );
}

/** Nothing waits: a check drawing itself in a ring. */
function InboxZero({ decided }: { decided: boolean }) {
  return (
    <div className="qa-zero" data-inbox-zero>
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        <circle className="qa-zero-ring" cx="36" cy="36" r="24" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
        <path className="qa-zero-check" d="M26 37 l7 7 l14 -16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className="qa-zero-t">Nothing needs you</p>
      <p className="qa-muted qa-zero-b">{decided ? "Every finding has a decision. New ones from your next runs land here first." : "No run has found anything yet. Anything a run finds lands here for triage."}</p>
    </div>
  );
}

/** Where a finding came from: its workflow step and round, or the task that was tested. */
function FindingSource({ f, cid }: { f: QaFinding; cid: string }) {
  const res = useLoad(f.request_id ? (s) => getRequest(f.request_id!, s) : null, [f.request_id]);
  const r = res.data;
  if (!r) return null;
  const where = [r.source_task_title, roundWord(r.round, r.max_rounds)].filter(Boolean).join(" · ");
  if (r.source_workflow_id) {
    return <p className="qa-tri-src" data-finding-source="workflow">Found in <Link className="qa-tasklink" to={workflowStepHref(r.source_workflow_id, r.source_task_id ?? "", cid)}>{r.source_workflow_title ?? "a workflow"}</Link> <span className="qa-muted">{where}</span></p>;
  }
  return r.source_task_title ? <p className="qa-tri-src" data-finding-source="task">Found testing {r.source_task_title}</p> : null;
}

function FindingInspector({ f, cid, auth, onClose, onChanged }: { f: QaFinding; cid: string; auth: QaAuthority; onClose: () => void; onChanged: () => void }) {
  const frames = (f.frame_ids ?? []).map((id, i) => ({ id, caption: `${f.title} (${i + 1})` }));
  return (
    <Inspector label={`Finding: ${f.title}`} title={f.title} onClose={onClose}>
      <div className="qa-insp" data-triage-finding={f.id}>
        <FindingDiagnosis finding={f} auth={auth} />
        <FindingSource f={f} cid={cid} />
        <div className="qa-actions">
          <FindingButtons finding={f} actions={{ auth, onChanged, explorationId: f.session_id, platform: f.platform ?? null }} />
          <ButtonLink size="sm" variant="ghost" to={sessionHref(f.session_id)}>Open the session</ButtonLink>
        </div>
        <Kv items={[["Expected", f.expected], ["What happened", f.actual], ["Screen", f.screen_key]]} />
        <Filmstrip label={`Screenshots for ${f.title}`} frames={frames} />
      </div>
    </Inspector>
  );
}

export function TriageView() {
  const { cid } = useSnapshot();
  const auth = qaAuthority(useActingAuthority());
  const [params, setParams] = useSearchParams();
  const changed = useRequestsChanged();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  const res = useLoad(cid ? (s) => getTriageInbox(cid, s) : null, [cid], tick + changed);
  const inbox = res.data;
  const selected = params.get("finding");
  const open = useCallback((id: string | null) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    if (id) next.set("finding", id); else next.delete("finding");
    return next;
  }, { replace: true }), [setParams]);
  const row = useMemo(() => (inbox ? [...inbox.untriaged, ...inbox.needs_person, ...inbox.decided].find((f) => f.id === selected) ?? null : null), [inbox, selected]);
  if (!cid) return null;
  if (res.error && !inbox) return <EmptyState tone="danger" title="Couldn't load triage" body={res.error} action={<Button size="sm" onClick={refresh}>Retry</Button>} />;
  if (!inbox) return <div className="qa-pad"><Skeleton lines={5} label="Loading triage" /></div>;
  const waiting = inbox.untriaged.length + inbox.needs_person.length;
  const list = (
    <div className="qa-listwrap" data-qa-triage>
      {waiting ? (
        <>
          <Group title="Untriaged" rows={inbox.untriaged} selected={selected} onOpen={open} note="Every finding has a diagnosis." />
          <Group title="Needs a person" rows={inbox.needs_person} selected={selected} onOpen={open} note="No judgement calls are waiting." />
        </>
      ) : <InboxZero decided={inbox.decided.length > 0} />}
      {inbox.decided.length ? <Group title="Recently decided" rows={inbox.decided} selected={selected} onOpen={open} note="" /> : null}
    </div>
  );
  return (
    <FrameLightboxProvider>
      <SplitPane storageKey="orcha:v2:qaTriageInspector" defaultSize={520} list={list} inspector={row ? <FindingInspector key={row.id} f={row} cid={cid} auth={auth} onClose={() => open(null)} onChanged={refresh} /> : null} />
    </FrameLightboxProvider>
  );
}
