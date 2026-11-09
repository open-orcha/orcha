/** A walk as the scenario and session screens show it: outcome, steps and their screenshots. */
import { Icon } from "../../../components/ui";
import { relTime } from "../../../lib/format";
import { Filmstrip } from "../Frames";
import { QaSection, QaStatus } from "../parts";
import { walkName, type QaWalk } from "../qaApi";
import { blockedKindWord, walkStatusGlyph, walkStatusWord } from "../qaWords";

/** A walk: outcome line, steps (reached or not) and the filmstrip of their screenshots. */
export function WalkBlock({ walk, title }: { walk: QaWalk; title?: string }) {
  const steps = walk.steps ?? [];
  const reached = steps.filter((x) => x.reached).length;
  const failedAt = walk.status === "failed" ? steps.find((x) => !x.reached) : null;
  const frames = steps.filter((x) => x.frame_id).map((x) => ({
    id: x.frame_id!,
    caption: `Step ${x.index + 1}: ${x.text}`,
    label: <span className={"qa-step-dot" + (x.reached ? " is-ok" : " is-bad")}>Step {x.index + 1}</span>,
  }));
  return (
    <QaSection title={title ?? (walkName(walk) || "Walk")} label={walkName(walk) || "Walk"}>
      <div className="qa-walk-h">
        <QaStatus glyph={walkStatusGlyph(walk.status)} word={walkStatusWord(walk.status)} show size={12} />
        {steps.length ? <span className="qa-muted">{reached} of {steps.length} steps reached</span> : null}
        {walk.ended_at || walk.started_at ? <span className="qa-muted">{relTime(walk.ended_at || walk.started_at)}</span> : null}
      </div>
      {failedAt ? <p className="qa-walk-why">Failed at step {failedAt.index + 1} of {steps.length}: {failedAt.text}</p> : null}
      {walk.status === "unreachable" ? (
        <p className="qa-walk-why">{blockedKindWord(walk.blocked_kind || "other")}{walk.reason ? ": " + walk.reason : ""}. Nothing drafted — a scenario is never written blind.</p>
      ) : walk.reason && walk.status !== "failed" ? <p className="qa-muted">{walk.reason}</p> : null}
      <Filmstrip label="Walk screenshots" frames={frames} />
      {steps.length ? (
        <ol className="qa-steps">
          {steps.map((x) => (
            <li key={x.index} className={x.reached ? "is-ok" : "is-bad"}>
              <Icon name={x.reached ? "check" : "x"} cls="v2-ico" />
              <span className="qa-step-t">{x.text}</span>
              {x.result ? <span className="qa-muted qa-step-r">{x.result}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </QaSection>
  );
}
