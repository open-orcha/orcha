/**
 * One session's run page, `?view=sessions&session=<id>&sub=run`: the theater, over one polled read
 * of the session (`GET /api/qa/sessions/{id}/run`), with the Activity panel beside it. While the
 * session runs the read repeats, and every panel follows; it stops when the session ends.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { QaAuthority } from "../authority";
import { ChevronLeft } from "../map/kit/icons";
import { qaHref } from "../parts";
import type { QaNav } from "../QaPage";
import { ActivityPanel, RunWatch } from "../run/ActivityPanel";
import { RunStateLine } from "../run/RunStateLine";
import { runHref } from "../run/runFlow";
import type { QaRunKind } from "../runQa";
import { runSessionAgain } from "../sessions/api";
import { FindingButtons } from "../sessions/detail/finding-actions";
import { FindingDiagnosis } from "../triage/TriageActions";
import { LIVE_POLL_MS } from "../sessions/detail/use-session-live";
import { theaterOf } from "./adapt";
import { getRun } from "./api";
import { usePolled } from "./live/use-polled";
import { LEAVE_RUN } from "./links";
import { deepLinkStepSeq } from "./replay/model";
import { RunFinding } from "./replay/run-finding";
import { RunTheater } from "./theater/run-theater";

function intParam(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function QaRun({ nav, sessionId, auth }: { cid: string; nav: QaNav; sessionId: string; auth?: QaAuthority }) {
  const who = auth ?? nav.auth;
  const [tick, setTick] = useState(0);
  const res = usePolled((s) => getRun(sessionId, s), sessionId, nav.nonce + tick, LIVE_POLL_MS, (d) => d.session.status === "running");
  const again = useCallback(() => setTick((n) => n + 1), []);
  const data = useMemo(() => (res.data ? theaterOf(res.data) : null), [res.data]);
  const doc = res.data;
  const stepParam = useMemo(() => {
    if (!data) return null;
    return deepLinkStepSeq(data.rows.steps, { step: intParam(nav.get("step")), action: intParam(nav.get("action")), finding: intParam(nav.get("finding")) }, { findings: data.rows.findings, evidence: data.rows.evidence });
  }, [data, nav]);
  const kind = (doc?.session.kind ?? "explore") as QaRunKind;
  const navigate = useNavigate();
  const from = nav.get("from");
  // The same work again, straight to its live page; the options page when it cannot be repeated.
  const rerun = useCallback(async () => {
    try {
      const next = await runSessionAgain(sessionId, who.human?.id ?? null);
      navigate(runHref(next, from), { replace: true });
    } catch {
      nav.runQa(kind, null, { platform: doc?.session.platform ?? null });
    }
  }, [sessionId, who.human?.id, navigate, from, nav, kind, doc?.session.platform]);
  // Drafting reads code and uses no device: its page is the drafting screen, never this one.
  const drafting = doc?.session.kind === "draft";
  useEffect(() => {
    if (drafting) navigate(qaHref({ view: "sessions", platform: nav.get("platform"), session: sessionId, from }), { replace: true });
  }, [drafting, navigate, nav, sessionId, from]);
  if (drafting) return null;
  const theater = (
    <RunTheater
      activity={<ActivityPanel auth={who} fill />}
      data={data}
      error={res.error ?? null}
      onRetry={again}
      onChanged={again}
      auth={who}
      onRerun={() => void rerun()}
      tabParam={nav.get("tab")}
      stepParam={stepParam}
      scenarioParam={nav.get("scenario")}
      leading={
        <button type="button" onClick={() => nav.goBack(LEAVE_RUN)} className="qa-back qa-back-run" aria-label="Back" title="Back" data-run-back data-qa-back>
          <ChevronLeft aria-hidden className="size-4" />
        </button>
      }
      back={doc ? <RunStateLine session={doc.session} from={from} onContinue={() => nav.goBack(LEAVE_RUN)} /> : null}
      renderFinding={(row) => {
        const stored = doc?.findings[row.finding.seq - 1];
        return (
          <RunFinding
            {...row}
            kind={data?.detail.kind}
            evidence={row.finding.evidence_seqs.map((n) => data?.rows.evidence.find((e) => e.seq === n)).filter((e): e is NonNullable<typeof e> => e != null)}
            actions={stored ? <><FindingDiagnosis finding={stored} auth={who} /><FindingButtons finding={stored} actions={{ auth: who, onChanged: again, explorationId: sessionId, platform: doc?.session.platform ?? null }} /></> : null}
          />
        );
      }}
    />
  );
  return <RunWatch sessionId={sessionId}>{theater}</RunWatch>;
}
