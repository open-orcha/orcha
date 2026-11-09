/** What triage decided, finding by finding: for a request and for a workflow's QA step. */
import { Link } from "react-router-dom";
import { Chip } from "../../../components/primitives";
import { sessionHref } from "../requests/links";
import type { DiagnosisRow } from "./api";
import { SeverityChange } from "./DiagnosisCard";
import { actionWord, classificationTone, classificationWord } from "./words";

export function DiagnosisList({ rows, platform, session }: { rows: readonly DiagnosisRow[]; platform: string | null; session: string | null }) {
  return (
    <ul className="qa-plain qa-req-findings" aria-label="What triage decided">
      {rows.map((d) => (
        <li key={d.id} className="qa-req-finding" data-diagnosis={d.classification}>
          <div className="qa-taskqa-row">
            <Chip size="sm" dot={classificationTone(d.classification)}>{classificationWord(d.classification)}</Chip>
            {session ? <Link className="qa-taskqa-t" to={sessionHref(session, platform)}>{d.title}</Link> : <span className="qa-taskqa-t">{d.title}</span>}
            {d.rate ? <span className="qa-diag-rate">{d.rate}</span> : null}
          </div>
          {d.root_cause ? <p className="qa-muted qa-req-note">{d.root_cause}</p> : null}
          <div className="qa-diag-foot">
            <SeverityChange before={d.severity_original} after={d.severity} />
            {actionWord(d.action) ? <span className="qa-muted qa-req-note">{actionWord(d.action)}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
