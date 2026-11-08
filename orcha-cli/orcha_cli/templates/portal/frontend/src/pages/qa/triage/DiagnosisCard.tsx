/**
 * The diagnosis on a finding: what it is, "fails 3 of 3", the root cause, severity before and after,
 * and what that did. It never goes blank once triage starts: queued, then running (a sweeping
 * hairline), then the diagnosis, or "Could not run" with the reason and a Retry. Nothing at all only
 * while triage never ran here.
 */
import { Link } from "react-router-dom";
import { Button, Chip } from "../../../components/primitives";
import { Icon } from "../../../components/ui";
import { relTime } from "../../../lib/format";
import { Filmstrip, FrameLightboxProvider } from "../Frames";
import { QaStatus } from "../parts";
import { qaHref } from "../parts";
import { severityTone, severityWord } from "../qaWords";
import { requestIdHref } from "../requests/links";
import type { QaRequest } from "../requests/api";
import type { Diagnosis } from "./api";
import { actionWord, classificationHint, classificationTone, classificationWord } from "./words";

export type TriagePhase = "idle" | "queued" | "running" | "done" | "failed";

/** The phase the card shows: a turn in flight wins over an older diagnosis. */
export function triagePhase(d: Diagnosis | null, request: Pick<QaRequest, "status"> | null | undefined): TriagePhase {
  if (request?.status === "requested") return "queued";
  if (request?.status === "running") return "running";
  if (d) return "done";
  if (request?.status === "cancelled" || request?.status === "blocked" || request?.status === "failed") return "failed";
  return "idle";
}

const PHASE: Record<Exclude<TriagePhase, "idle" | "done">, { glyph: string; word: string }> = {
  queued: { glyph: "pending", word: "Queued" },
  running: { glyph: "in_progress", word: "Running" },
  failed: { glyph: "failed", word: "Could not run" },
};

/** "Major → Minor", or the one severity when triage kept it. */
export function SeverityChange({ before, after }: { before: string | null | undefined; after: string | null | undefined }) {
  if (!after) return null;
  if (!before || before === after) return <Chip size="sm" dot={severityTone(after)}>{severityWord(after)}</Chip>;
  return (
    <span className="qa-diag-sev" aria-label={`Severity changed from ${severityWord(before)} to ${severityWord(after)}`} data-severity-change>
      <Chip size="sm" dot={severityTone(before)}>{severityWord(before)}</Chip>
      <span className="qa-muted" aria-hidden="true">→</span>
      <Chip size="sm" dot={severityTone(after)}>{severityWord(after)}</Chip>
    </span>
  );
}

export const findingHref = (id: string) => qaHref({ view: "triage", finding: id });

export function DiagnosisCard({ diagnosis: d, severity, severityOriginal, duplicateOf, request, onRetry }: {
  diagnosis: Diagnosis | null; severity?: string | null; severityOriginal?: string | null;
  /** The open finding this one repeats. */
  duplicateOf?: string | null;
  /** The newest triage turn on this finding. */
  request?: QaRequest | null;
  /** Opens the confirm dialog again; never queues by itself. */
  onRetry?: () => void;
}) {
  const phase = triagePhase(d, request);
  if (phase === "idle") return null;
  const pending = phase === "queued" || phase === "running";
  const done = phase === "done" && !!d;
  const frames = done ? d.evidence_frame_ids.map((id, i) => ({ id, caption: `Triage screenshot ${i + 1}` })) : [];
  return (
    <section className="qa-diag" aria-label="Triage" aria-live="polite" data-triage-panel data-triage-phase={phase}>
      <div className="qa-diag-h">
        <Icon name="eye" cls="v2-ico qa-diag-ico" />
        <span className="qa-diag-t">Triage</span>
        {done ? <span className="qa-diag-in"><Chip size="sm" dot={classificationTone(d.classification)} data-classification={d.classification}>{classificationWord(d.classification)}</Chip></span> : (
          <QaStatus glyph={PHASE[phase as keyof typeof PHASE].glyph} word={PHASE[phase as keyof typeof PHASE].word} show size={12} />
        )}
        {done && d.rate ? <span className="qa-diag-rate" title="Attempts that reproduced it">{d.rate}</span> : null}
        {done && d.needs_person ? <Chip size="sm" dot="warn">Needs a person</Chip> : null}
        {done && d.at ? <span className="qa-muted qa-diag-at">{relTime(d.at)}</span> : null}
        <span className="v2-grow" />
        {request ? <Link className="qa-tasklink qa-diag-link" to={requestIdHref(request.id)}>Open the request</Link> : null}
      </div>
      {pending ? (
        <div className="qa-diag-pending" data-triage-pending>
          <div className={"qa-diag-track" + (phase === "queued" ? " is-queued" : "")} aria-hidden="true"><span /></div>
          <p className="qa-muted qa-diag-p">{phase === "running" ? "The agent is re-running the failing part. It attempts it at least three times." : "Queued. It starts as soon as the QA agent and a device are free."}</p>
        </div>
      ) : null}
      {phase === "failed" ? (
        <div className="qa-diag-failed" data-triage-failed>
          <p className="qa-diag-p">{request?.result?.summary || "The turn stopped before it finished."}</p>
          {onRetry ? <Button size="sm" icon="refresh" onClick={onRetry} data-triage-retry>Retry</Button> : null}
        </div>
      ) : null}
      {done ? (
        <>
          {classificationHint(d.classification) ? <p className="qa-muted qa-diag-p" data-triage-hint>{classificationHint(d.classification)}</p> : null}
          {duplicateOf ? <p className="qa-diag-p"><Link className="qa-tasklink" to={findingHref(duplicateOf)} data-duplicate-of={duplicateOf}>Open the finding it repeats</Link></p> : null}
          {d.merged_from.length ? <p className="qa-muted qa-diag-p" data-merged>{d.merged_from.length === 1 ? "One duplicate was merged into this finding." : `${d.merged_from.length} duplicates were merged into this finding.`}</p> : null}
          {d.root_cause ? <p className="qa-diag-cause"><span className="qa-muted">Root cause: </span>{d.root_cause}</p> : null}
          {d.note && d.note !== d.root_cause ? <p className="qa-diag-p">{d.note}</p> : null}
          {!d.root_cause && !d.note ? <p className="qa-muted qa-diag-p" data-triage-no-summary>No diagnosis text was given.</p> : null}
          <div className="qa-diag-foot">
            <SeverityChange before={severityOriginal} after={severity} />
            {actionWord(d.action) ? <span className="qa-muted qa-diag-p" data-triage-action={d.action ?? ""}>{actionWord(d.action)}</span> : null}
          </div>
          {frames.length ? <FrameLightboxProvider><Filmstrip label="Triage screenshots" frames={frames} /></FrameLightboxProvider> : null}
        </>
      ) : null}
    </section>
  );
}
