/**
 * Why the flow is where it is: the Quality loop, round by round, above the steps and the graph. A
 * person sees at a glance what each round found, what triage kept and why the work went back. Each
 * step opens in the inspector; while a session runs, its device is one click away.
 */
import { ButtonLink, Chip } from "../../components/primitives";
import { QaStatus } from "../qa/parts";
import { severityTone, severityWord } from "../qa/qaWords";
import { runPageHref } from "../qa/requests/links";
import type { QaRequest } from "../qa/requests/api";
import { requestStatusGlyph, requestStatusWord } from "../qa/requests/words";
import { decisionOf } from "../qa/triage/words";
import { Icon } from "../../components/ui";
import type { QualityRound, RoundState } from "./qualityRounds";
import { roundsHeadline } from "./qualityRounds";

const STATE: Record<RoundState, { word: string; tone: "ok" | "danger" | "warn" | "neutral" }> = {
  running: { word: "Running", tone: "warn" }, waiting: { word: "Needs your review", tone: "warn" }, back: { word: "Went back", tone: "danger" }, passed: { word: "Passed", tone: "ok" },
  clear: { word: "Clear", tone: "ok" }, person: { word: "Needs a person", tone: "warn" }, blocked: { word: "Blocked", tone: "warn" }, cancelled: { word: "Cancelled", tone: "neutral" },
};

const MAX_SHOWN = 3;

function Step({ request, word, onOpen }: { request: QaRequest; word: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="wf-story-step" onClick={() => request.source_task_id && onOpen(request.source_task_id)}>
      <QaStatus glyph={requestStatusGlyph(request.status)} word={requestStatusWord(request.status)} size={12} />
      <span>{word}</span>
    </button>
  );
}

function triageWord(r: QaRequest): string {
  const all = r.result?.diagnoses.length ?? 0;
  const decision = decisionOf(r.result, r.status);
  if (decision === "fix") return `Triage: ${r.result!.confirmed_ids.length} of ${all} confirmed`;
  if (decision === "clear") return "Triage: clear";
  if (decision === "needs_person") return "Triage: needs a person";
  return `Triage: ${requestStatusWord(r.status).toLowerCase()}`;
}

function qualityWordOf(r: QaRequest): string {
  const n = r.result?.findings.length ?? 0;
  return `Quality: ${requestStatusWord(r.status).toLowerCase()}${n ? `, ${n} ${n === 1 ? "finding" : "findings"}` : ""}`;
}

function Round({ r, latest, onOpen }: { r: QualityRound; latest: boolean; onOpen: (id: string) => void }) {
  const shown = r.findings.slice(0, MAX_SHOWN);
  const live = r.state === "running" ? (r.triage ?? r.quality) : null;
  const backing = r.state === "back" || (r.state === "waiting" && !!r.backTo);
  return (
    <li className={"wf-story-round" + (backing ? " is-back" : "")} data-round={r.round} data-round-state={r.state}>
      <div className="wf-story-line">
        <span className="wf-story-n">Round {r.round}</span>
        {r.quality ? <Step request={r.quality} word={r.state === "running" && !r.triage ? r.headline.replace(" is ", ": ") : r.state === "person" && r.quality.status === "requested" ? "Quality: stopped" : qualityWordOf(r.quality)} onOpen={onOpen} /> : null}
        {r.triage ? <><Icon name="chev-right" cls="v2-ico wf-story-arrow" /><Step request={r.triage} word={r.state === "running" ? r.headline.replace(" is ", ": ") : triageWord(r.triage)} onOpen={onOpen} /></> : null}
        {r.next ? <span className={"wf-story-next" + (backing ? " is-back" : "")}>{backing ? <span aria-hidden="true">↺ </span> : null}{r.next}</span> : null}
        <span className="v2-grow" />
        <Chip size="sm" dot={STATE[r.state].tone}>{STATE[r.state].word}</Chip>
        {live?.session_id && live.status === "running" ? <ButtonLink size="sm" icon="live" to={runPageHref(live.session_id, live.platform)}>Watch the device</ButtonLink> : null}
      </div>
      {shown.length && (backing || latest) ? (
        <ul className="qa-plain wf-story-why" aria-label={`Why round ${r.round} went back`}>
          {shown.map((f) => (
            <li key={f.id}>
              <div className="wf-story-f">
                {f.severity ? <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip> : null}
                <span className="wf-story-t">{f.title}</span>
                {f.rate ? <span className="qa-diag-rate">{f.rate}</span> : null}
              </div>
              {f.rootCause ? <p className="wf-muted wf-story-cause">{f.rootCause}</p> : null}
            </li>
          ))}
          {r.findings.length > shown.length ? <li className="wf-muted">and {r.findings.length - shown.length} more</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

export function WorkflowQualityRounds({ rounds, round, maxRounds, onOpen }: { rounds: readonly QualityRound[];
  /** The loop's round now: ahead of the last Quality round while the fix is being built. */
  round: number | null; maxRounds: number | null; onOpen: (taskId: string) => void }) {
  const latest = rounds.at(-1);
  if (!latest) return null;
  const now = Math.max(round ?? 0, latest.round);
  return (
    <section className="wf-story" aria-label="Quality rounds" data-quality-rounds>
      <div className="wf-story-h">
        <Icon name="shield" cls="v2-ico" />
        <span className="wf-story-title">Quality</span>
        <span className="wf-muted">{maxRounds ? `Round ${now} of ${maxRounds}` : `Round ${now}`}</span>
      </div>
      <p className="wf-story-head" data-rounds-headline>{roundsHeadline(rounds)}</p>
      <ol className="qa-plain wf-story-list">
        {rounds.map((r) => <Round key={r.round} r={r} latest={r === latest} onOpen={onOpen} />)}
      </ol>
    </section>
  );
}
