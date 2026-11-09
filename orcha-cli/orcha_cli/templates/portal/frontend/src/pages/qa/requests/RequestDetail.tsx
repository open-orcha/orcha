/**
 * One request: what was asked (the lines to prove, the build), each line's verdict with its
 * screenshots, the findings, and links to the session and its run page. Cancel is a person's call.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ButtonLink, Button, Chip, ConfirmDialog, EmptyState, Inspector, Skeleton, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { relTime } from "../../../lib/format";
import type { QaAuthority } from "../authority";
import { Filmstrip, FrameShapeProvider, type FrameItem } from "../Frames";
import { errText, Kv, QaSection, QaStatus, TaskLink, qaHref, useAgentAlias, useLoad } from "../parts";
import type { Platform, QaFinding, Verdict } from "../qaApi";
import { platformWord, severityTone, severityWord, verdictGlyph, verdictWord, findingStatusWord } from "../qaWords";
import { cancelRequest, getRequest, type QaLineResult, type QaRequest } from "./api";
import { linesOf } from "./lines";
import { requestIdHref, runPageHref, sessionHref } from "./links";
import { isOpenRequest } from "./model";
import { SourceLinks } from "./RequestSource";
import { DiagnosisList } from "../triage/DiagnosisList";
import { decisionOf, decisionWord } from "../triage/words";
import { onFailWord, requestKindWord, requestOriginWord, requestStatusGlyph, requestStatusWord, requestTitle, roundWord } from "./words";

/** One acceptance line with its verdict and screenshots. */
export function RequestLine({ line, n }: { line: QaLineResult; n: number }) {
  const v = line.verdict as Verdict | null;
  const frames: (FrameItem & { label?: string })[] = line.frame_ids.map((id, i) => ({ id, caption: `Line ${n}: ${v ? verdictWord(v) : "Screenshot"}${line.frame_ids.length > 1 ? ` (${i + 1})` : ""}` }));
  return (
    <li className="qa-crit" data-line-verdict={v ?? "none"}>
      <span className="qa-crit-n">{n}</span>
      <div className="qa-crit-b">
        <p className="qa-crit-t">{line.text}</p>
        <div className="qa-crit-evrow">
          {v ? <QaStatus glyph={verdictGlyph(v)} word={verdictWord(v)} show size={12} /> : <span className="qa-muted">Not checked yet</span>}
          {line.note ? <span className="qa-muted">{line.note}</span> : null}
        </div>
        <Filmstrip label={`Screenshots for line ${n}`} frames={frames} />
      </div>
    </li>
  );
}

/** A finding's row: severity, title, its screenshots, and the task it was filed as. */
function FindingRow({ f, platform, session }: { f: QaFinding; platform: string | null; session: string | null }) {
  const sid = f.session_id ?? session;
  const frames = (f.frame_ids ?? []).map((id, i) => ({ id, caption: `${f.title}${(f.frame_ids ?? []).length > 1 ? ` (${i + 1})` : ""}` }));
  return (
    <li className="qa-req-finding">
      <div className="qa-taskqa-row">
        <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip>
        {sid ? <Link className="qa-taskqa-t" to={sessionHref(sid, platform)}>{f.title}</Link> : <span className="qa-taskqa-t">{f.title}</span>}
        {f.status === "filed" && f.filed_task_id ? <TaskLink id={f.filed_task_id} title={f.filed_task_title} className="qa-muted" /> : f.status ? <span className="qa-muted">{findingStatusWord(f.status)}</span> : null}
      </div>
      {f.actual ? <p className="qa-muted qa-req-note">{f.actual}</p> : null}
      <Filmstrip label={`Screenshots for ${f.title}`} frames={frames} />
    </li>
  );
}

/** The findings of a request: the detail read joins them, and the result keeps what its run found. */
export function requestFindings(r: QaRequest | null): QaFinding[] {
  if (!r) return [];
  return r.findings.length ? r.findings : r.result?.findings ?? [];
}

export function RequestDetail({ id, seed, auth, nonce, onClose, onChanged }: {
  id: string; seed: QaRequest | null; auth: QaAuthority; nonce: number; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const res = useLoad((s) => getRequest(id, s), [id], nonce);
  const r = res.data ?? seed;
  const findings = requestFindings(r);
  const by = useAgentAlias(r?.requested_by_agent_id, r?.requested_by_alias);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!r) {
    return (
      <Inspector title="Request" onClose={onClose}>
        <div className="qa-insp">{res.error ? <EmptyState tone="danger" title="Couldn't load this request" body={res.error} /> : <Skeleton lines={5} label="Loading the request" />}</div>
      </Inspector>
    );
  }
  const open = isOpenRequest(r);
  const lines = linesOf(r);
  const session = r.session_id;
  const cancel = async () => {
    setBusy(true);
    try {
      await cancelRequest(r.id, auth.human?.id ?? null);
      toast("Request cancelled", "ok");
      setConfirm(false);
      onChanged();
    } catch (e) {
      toast("Couldn't cancel it — " + errText(e), "danger", { sticky: true });
    } finally {
      setBusy(false);
    }
  };
  const cancelBtn = <Button size="sm" variant="ghost" disabled={!auth.can} onClick={() => setConfirm(true)}>Cancel request</Button>;
  return (
    <Inspector label={`QA request: ${requestTitle(r)}`} title={<><QaStatus glyph={requestStatusGlyph(r.status)} word={requestStatusWord(r.status, r.kind)} /> {requestTitle(r)}</>} onClose={onClose}
      meta={<span className="qa-insp-meta">{[requestStatusWord(r.status, r.kind), roundWord(r.round, r.max_rounds), relTime(r.created_at)].join(" · ")}</span>}>
      <FrameShapeProvider shape={r.platform === "web" ? "wide" : "phone"}>
        <div className="qa-insp" data-qa-request={r.id}>
          <QaSection title="Result" actions={open ? (auth.can ? cancelBtn : <Tooltip label={auth.reason || "Only a person can cancel a request"} placement="bottom">{cancelBtn}</Tooltip>) : undefined}>
            {r.result?.summary ? <p className="qa-pre">{r.result.summary}</p> : <p className="qa-muted qa-empty-line">{open ? "Nothing back yet. QA is still on it." : r.status === "cancelled" ? "Cancelled before a result came back." : "No summary came back."}</p>}
            <div className="qa-actions">
              {session ? <ButtonLink size="sm" to={sessionHref(session, r.platform)}>Open the session</ButtonLink> : null}
              {session ? <ButtonLink size="sm" variant="ghost" icon={open ? "live" : undefined} to={runPageHref(session, r.platform)}>{open ? "Watch the device" : "Open the run page"}</ButtonLink> : null}
            </div>
            <p className="qa-muted qa-gate">A QA result never verifies a task. A person still does.</p>
          </QaSection>
          <QaSection title="What was asked">
            <Kv items={[
              ["Came from", <SourceLinks key="s" r={r} none="Quality" />],
              ["Asked by", by],
              ["How", requestOriginWord(r.origin)],
              ["Kind", requestKindWord(r.kind)],
              ["Platform", r.platform ? platformWord(r.platform as Platform) : null],
              ["Focus", r.focus],
              ["If it fails", onFailWord(r.on_fail)],
              ["QA task", r.qa_task_id ? <TaskLink key="q" id={r.qa_task_id} title={r.qa_task_title} /> : null],
              ["Plan approved by", r.approved_by_alias],
              ["Scenarios", r.scenario_ids.length ? String(r.scenario_ids.length) : null],
              ["Tags", r.tags.length ? <span key="tags" className="qa-chips">{r.tags.map((t) => <Chip key={t} size="sm">{t}</Chip>)}</span> : null],
            ]} />
          </QaSection>
          {r.build ? (
            <QaSection title="Build">
              <Kv items={[
                ["Branch", r.build.branch ? <span key="b" className="qa-mono">{r.build.branch}</span> : null],
                ["Commit", r.build.commit ? <span key="c" className="qa-mono">{r.build.commit}</span> : null],
                ["Address", r.build.url ? <span key="u" className="qa-mono">{r.build.url}</span> : null],
                ["App file", r.build.app_path ? <span key="a" className="qa-mono">{r.build.app_path}</span> : null],
                ["Notes", r.build.notes],
              ]} />
            </QaSection>
          ) : null}
          {lines.length ? (
            <QaSection title="Lines to prove" count={lines.length}>
              <ol className="qa-criteria" aria-label="Lines to prove">{lines.map((l, i) => <RequestLine key={i} line={l} n={i + 1} />)}</ol>
            </QaSection>
          ) : null}
          {r.result?.diagnoses.length ? (
            <QaSection title="What triage decided" count={r.result.diagnoses.length} actions={decisionWord(decisionOf(r.result, r.status)) ? <span className="qa-muted">{decisionWord(decisionOf(r.result, r.status))}</span> : undefined}>
              <DiagnosisList rows={r.result.diagnoses} platform={r.platform} session={r.session_id} />
            </QaSection>
          ) : null}
          {r.result?.scenarios.length ? (
            <QaSection title="Scenarios" count={r.result.scenarios.length}>
              <ul className="qa-plain">
                {r.result.scenarios.map((s) => (
                  <li key={s.scenario_id} className="qa-taskqa-row">
                    {s.verdict ? <QaStatus glyph={verdictGlyph(s.verdict)} word={verdictWord(s.verdict)} size={12} /> : null}
                    <Link className="qa-taskqa-t" to={qaHref({ view: "scenarios", platform: r.platform && r.platform !== "ios" ? r.platform : null, scenario: s.scenario_id })}>{s.name || "Scenario"}</Link>
                    {s.verdict ? <span className="qa-muted">{verdictWord(s.verdict)}</span> : null}
                  </li>
                ))}
              </ul>
            </QaSection>
          ) : null}
          {r.rounds.length > 1 ? (
            <QaSection title="Rounds" count={r.rounds.length}>
              <ol className="qa-plain" aria-label="Rounds">
                {r.rounds.map((x) => (
                  <li key={x.id}>
                    <Link className="qa-taskqa-row" to={requestIdHref(x.id)} aria-current={x.id === r.id ? "true" : undefined}>
                      <QaStatus glyph={requestStatusGlyph(x.status)} word={requestStatusWord(x.status)} size={12} />
                      <span className="qa-taskqa-t">{roundWord(x.round)}{x.summary ? `: ${x.summary}` : ""}</span>
                      <span className="qa-muted">{requestStatusWord(x.status)}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </QaSection>
          ) : null}
          {findings.length ? (
            <QaSection title="Findings" count={findings.length}>
              <ul className="qa-plain qa-req-findings" aria-label="Findings">{findings.map((f) => <FindingRow key={f.id} f={f} platform={r.platform} session={r.session_id} />)}</ul>
            </QaSection>
          ) : null}
        </div>
      </FrameShapeProvider>
      {confirm ? (
        <ConfirmDialog title="Cancel this request?" description="QA stops working on it. The task it came from stays as it is." confirmLabel="Cancel request" cancelLabel="Keep it" danger busy={busy} onClose={() => setConfirm(false)} onConfirm={() => void cancel()} />
      ) : null}
    </Inspector>
  );
}
