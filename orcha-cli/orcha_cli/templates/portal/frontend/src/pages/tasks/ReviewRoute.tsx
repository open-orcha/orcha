/**
 * Manager review handoff (mig 057) inside the verification gate.
 *
 *  - ReviewRouteRow: "Reviewer: maya · via Forge's manager" + the AI manager's
 *    pre-review status / recommendation ("Atlas (manager) recommends approval: …").
 *    Advisory only — the gate's Accept / Reject stay the human's decision.
 *  - ManagerSentBackNote: the AI manager returned finished work to its assignee;
 *    a person may still accept it as delivered ("Accept anyway" →
 *    POST /api/tasks/{tid}/verify {approve:true}, allowed by the backend only
 *    in this state).
 */
import { useState } from "react";
import { Icon } from "../../components/ui";
import { Button } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { managerReviewLine, reviewRouteLine } from "../../lib/reviewRoute";
import type { Task } from "../../types";
import "./reviewRoute.css";

export function ReviewRouteRow({ t }: { t: Task }) {
  const route = reviewRouteLine(t);
  const mr = managerReviewLine(t.manager_review);
  if (!route && !mr) return null;
  return (
    <div className="td-g-row field" data-review-route={t.review_routing?.routed_via || ""}>
      <span className="td-g-k">Review</span>
      <div className="td-g-v td-g-review">
        {route ? <div className="td-g-route">{route}</div> : null}
        {mr ? (
          <div className={"td-g-mgr is-" + mr.tone} data-manager-review={t.manager_review?.status}>
            <Icon name={mr.tone === "ok" ? "check" : mr.tone === "bad" ? "x" : "spark"} cls="v2-ico" />
            <span>
              {mr.text}
              {t.manager_review?.decided_at ? <span className="v2-muted"> · {relTime(t.manager_review.decided_at)}</span> : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ManagerSentBackNote({ t, why, onAccept }: {
  t: Task;
  /** why the acting person can't accept (null = can) */
  why: string | null;
  onAccept: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const mr = t.manager_review;
  const who = mr?.manager_alias || "The manager";
  return (
    <div className="wk-decided td-decided" data-kind="manager-sent-back" role="note">
      <span className="wk-bad"><Icon name="x" cls="v2-ico" /></span>
      <div className="v2-grow">
        <span className="wk-dt">{who} (manager) sent this back</span>
        <span className="wk-dm">
          {mr?.decided_at ? " · " + relTime(mr.decided_at) : ""}
          {mr?.reasons ? " — " + mr.reasons : ""}
        </span>
      </div>
      <Button
        variant="secondary"
        size="sm"
        data-act="accept-anyway"
        disabled={!!why || busy}
        title={why || "Accept the delivered result despite the manager's feedback — you still verify"}
        onClick={async () => {
          setBusy(true);
          await onAccept();
          setBusy(false);
        }}
      >
        Accept anyway
      </Button>
    </div>
  );
}
