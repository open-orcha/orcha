/**
 * Triage and Mark as not a bug, on any finding. Triage asks first: it holds a device and spends
 * model time, so it is never one click. Not a bug needs a reason: QA agents read it and never report
 * that behaviour again. Both are a person's calls.
 */
import { useId, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { Button, ConfirmDialog, Dialog, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { useRequestsChanged, requestsChanged } from "../../../state/qaRequestBus";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { errText, useLoad } from "../parts";
import type { Platform, QaFinding } from "../qaApi";
import { ConditionsField } from "../conditions/ConditionsField";
import { cleanConditions, conditionWords, type Conditions } from "../conditions/conditions";
import { listRequests, type QaRequest } from "../requests/api";
import { requestHref, runPageHref } from "../requests/links";
import { isOpenRequest, newestFirst } from "../requests/model";
import { markNotABug, normalizeDiagnosis, setFindingConditions, startTriage } from "./api";
import { DiagnosisCard } from "./DiagnosisCard";

/* One read per change serves every finding on a page. */
const shared = new Map<string, Promise<QaRequest[]>>();
function triageRequests(cid: string, nonce: number): Promise<QaRequest[]> {
  const key = `${cid}:${nonce}`;
  const hit = shared.get(key);
  if (hit) return hit;
  const rows = listRequests(cid, { kind: "triage" }).catch(() => [] as QaRequest[]);
  shared.clear();
  shared.set(key, rows);
  return rows;
}

/** The newest triage turn on this finding. */
export function useTriageRequest(fid: string): QaRequest | null {
  const { cid } = useSnapshot();
  const changed = useRequestsChanged();
  const res = useLoad(cid ? () => triageRequests(cid, changed) : null, [cid], changed);
  return newestFirst((res.data ?? []).filter((r) => r.finding_ids.includes(fid)))[0] ?? null;
}

/** "Start triage" with what it costs, then the request. Open from a button, or from Retry. With
 * `reproduce`, it asks first under which conditions (an OS version, a language, an account): the
 * finding's own, changed here and kept on it. */
export function TriageDialog({ finding, auth, onClose, reproduce = false }: {
  finding: Pick<QaFinding, "id" | "title"> & { conditions?: Conditions | null; platform?: Platform | null };
  auth: QaAuthority; onClose: () => void; reproduce?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const own = cleanConditions(finding.conditions);
  const [conditions, setConditions] = useState<Conditions | null>(own);
  const start = async () => {
    setBusy(true);
    try {
      const asked = cleanConditions(conditions);
      if (reproduce && JSON.stringify(asked) !== JSON.stringify(own)) await setFindingConditions(finding.id, auth.human?.id ?? null, asked);
      await startTriage(finding.id, auth.human?.id ?? null, asked);
      requestsChanged();
      toast("Triage queued", "ok");
      onClose();
    } catch (e) {
      toast("Couldn't start triage — " + errText(e), "danger", { sticky: true });
    } finally {
      setBusy(false);
    }
  };
  const said = conditionWords(own, finding.platform);
  const description = `An agent re-runs the failing part of “${finding.title}” at least three times, reads the code and finds the root cause. It holds a device and spends model time while it runs.`
    + (!reproduce && said.length ? ` It runs under the conditions it was found under: ${said.join(", ")}.` : "");
  if (!reproduce) {
    return <ConfirmDialog title="Triage this finding?" confirmLabel="Start triage" busy={busy} onClose={onClose} onConfirm={() => void start()} description={description} />;
  }
  return (
    <Dialog title="Reproduce under conditions" size="md" onClose={onClose} description={description}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={() => void start()} data-triage-reproduce-start>Reproduce</Button>
      </>}>
      <form className="qa-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <ConditionsField value={conditions} onChange={setConditions} platform={finding.platform ?? null} label="Reproduce it under" />
      </form>
    </Dialog>
  );
}

/** Mark as not a bug: the reason is required. */
export function NotABugDialog({ finding, auth, onDone, onClose }: { finding: Pick<QaFinding, "id" | "title">; auth: QaAuthority; onDone: () => void; onClose: () => void }) {
  const toast = useToast();
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const empty = !reason.trim();
  const save = async () => {
    if (empty) return;
    setBusy(true);
    setErr(null);
    try {
      await markNotABug(finding.id, auth.human?.id ?? null, reason.trim());
      toast("Marked as not a bug. QA won't report it again.", "ok");
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Mark as not a bug?" size="sm" onClose={onClose}
      description="The finding is dismissed, and QA agents read your reason: this behaviour is never reported again."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={empty} onClick={() => void save()}>Mark as not a bug</Button>
      </>}>
      <form className="qa-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="qa-field">
          <label className="qa-label" htmlFor={id}>Why it's not a bug</label>
          <textarea id={id} className="qa-input qa-textarea" rows={3} maxLength={2000} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {err ? <p className="qa-error" role="alert">{err}</p> : null}
      </form>
    </Dialog>
  );
}

/** The two buttons, shown while the finding is still a claim. */
export function TriageButtons({ finding, auth, onChanged, size = "sm" }: { finding: Pick<QaFinding, "id" | "title" | "status"> & { triage?: unknown; conditions?: Conditions | null; platform?: Platform | null }; auth: QaAuthority; onChanged: () => void; size?: "sm" | "md" }) {
  const request = useTriageRequest(finding.id);
  const [dialog, setDialog] = useState<"triage" | "reproduce" | "not_a_bug" | null>(null);
  const diagnosis = normalizeDiagnosis(finding.triage);
  if (finding.status === "dismissed" || diagnosis?.classification === "not_a_bug") return null;
  const gate = (node: ReactElement, key: string) => (auth.can ? node : <Tooltip key={key} label={auth.reason || "Only a person can do this"} placement="bottom">{node}</Tooltip>);
  const inFlight = !!request && isOpenRequest(request);
  return (
    <>
      {diagnosis || inFlight ? null : gate(<Button size={size} disabled={!auth.can} onClick={() => setDialog("triage")} data-triage-start>Triage</Button>, "t")}
      {inFlight ? <Link className="qa-tasklink" to={request.session_id ? runPageHref(request.session_id, request.platform) : requestHref(request)} data-triage-running>Triage is running. Open it</Link> : null}
      {inFlight ? null : gate(<Button size={size} variant="ghost" disabled={!auth.can} onClick={() => setDialog("reproduce")} data-triage-reproduce>Reproduce with conditions</Button>, "r")}
      {gate(<Button size={size} variant="ghost" disabled={!auth.can} onClick={() => setDialog("not_a_bug")} data-not-a-bug>Mark as not a bug</Button>, "n")}
      {dialog === "triage" || dialog === "reproduce" ? <TriageDialog finding={finding} auth={auth} reproduce={dialog === "reproduce"} onClose={() => setDialog(null)} /> : null}
      {dialog === "not_a_bug" ? <NotABugDialog finding={finding} auth={auth} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(); }} /> : null}
    </>
  );
}

/** A finding's diagnosis card, wired to its newest turn. */
export function FindingDiagnosis({ finding, auth }: { finding: Pick<QaFinding, "id" | "title" | "severity"> & { triage?: unknown; severity_original?: string | null; duplicate_of?: string | null }; auth: QaAuthority }) {
  const request = useTriageRequest(finding.id);
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <DiagnosisCard diagnosis={normalizeDiagnosis(finding.triage)} severity={finding.severity} severityOriginal={finding.severity_original} duplicateOf={finding.duplicate_of} request={request} onRetry={auth.can ? () => setRetrying(true) : undefined} />
      {retrying ? <TriageDialog finding={finding} auth={auth} onClose={() => setRetrying(false)} /> : null}
    </>
  );
}
