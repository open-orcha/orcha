import { useEffect, useState } from "react";
import { Badge } from "../../components/primitives";
import { Button } from "../../components/primitives/Button";
import { availableActionReason, workflowPaths, workflowRequest } from "./workflowApi";
import { evidenceReference, evidenceSupplier, evidenceUsable, WorkflowEvidencePanel, type EvidenceSupplier } from "./WorkflowEvidence";
import type { EvidenceReference, RoutingPreview, WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";
import { sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import { WorkflowOperationNotice } from "./WorkflowOperationNotice";

/** Plan approval and result acceptance are different decisions. This form only
 * accepts/rejects the exact submitted result, using the workflow receipt route. A step that
 * declares outcomes (version 2) also records its outcome; acceptance applies that outcome's rule. */
export function WorkflowTaskDecision({ detail, task, scope, verified, stale, onSaved }: {
  detail: WorkflowDetail; task: WorkflowTask; scope: DraftScope; verified: boolean; stale: boolean;
  onSaved: (detail: WorkflowDetail) => void;
}) {
  const [action, setAction] = useState<"accept" | "reject">("accept");
  const [reason, setReason] = useWorkflowForm(scope, `task:${task.id}:decision`, "");
  const [evidence, setEvidence] = useState<EvidenceReference | null>(null);
  const [supplier, setSupplier] = useState<EvidenceSupplier | null>(null);
  const [supplierRequired, setSupplierRequired] = useState(false);
  const reported = task.reported_outcome ?? null;
  const outcomes = task.outcomes ?? [];
  const reportedFindings = (reported?.findings ?? []).map((f) => f.text).join("\n");
  const [outcome, setOutcome] = useState(reported?.outcome ?? "");
  const [findings, setFindings] = useState(reportedFindings);
  const [preview, setPreview] = useState<{ detail: WorkflowDetail; basis: string; route: RoutingPreview | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = `workflow:${detail.id}`;
  const operation = useWorkflowOperation(scope, slot);
  const unresolved = operation?.state === "sending" || operation?.state === "uncertain";
  const permission = (current: WorkflowDetail, verb = action) => {
    if (current.hidden) return "Restore this hidden workflow before reviewing work.";
    const target = current.tasks.find((t) => t.id === task.id);
    return current.id !== detail.id || current.container_id !== scope.project || !target
      ? "This task is no longer in this workflow. Refresh before continuing."
      : availableActionReason(current.capability, target.available_actions, verb, verified);
  };
  const routed = action === "accept" && outcomes.length > 0;
  // What the chosen outcome would do, read live from the server's routing preview (#362 x06).
  const [live, setLive] = useState<RoutingPreview | null>(null);
  useEffect(() => {
    setLive(null);
    if (!routed || !outcomes.some((o) => o.name === outcome)) return;
    let active = true; const controller = new AbortController();
    void workflowRequest("RoutingPreview", `/api/tasks/${encodeURIComponent(task.id)}/outcome/preview`,
      { method: "POST", body: { outcome, expected_work_revision: task.work_revision }, actorId: scope.identity, signal: controller.signal })
      .then((route) => { if (active && route.task_id === task.id && route.outcome === outcome) setLive(route); }).catch(() => { if (active) setLive(null); });
    return () => { active = false; controller.abort(); };
  }, [routed, outcome, task.id, task.work_revision, detail.revision]);
  const group = detail.repeat_groups?.find((g) => g.member_tasks.includes(task.id));
  const titleOf = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const routeLine = (name: string) => {
    const rule = task.routes?.find((r) => r.outcome === name);
    switch (rule?.destination ?? "next") {
      case "return": return `↺ ${titleOf(rule?.destination_task)}, then ${task.title} again${group ? ` · round ${group.current_round + 1}` : ""}`;
      case "step": return `→ ${titleOf(rule?.destination_task)}`;
      case "ask_owner": return "? The owner decides what happens next";
      case "exit_group": return "→ Leaves the loop";
      case "stop": return "■ Stops the workflow";
      default: { const next = detail.tasks.filter((t) => t.depends_on.includes(task.id)).map((t) => t.title);
        return `→ ${next.length ? next.join(", ") : "Nothing else waits on this step"}`; }
    }
  };
  const findingList = findings.split("\n").map((f) => f.trim()).filter(Boolean).slice(0, 50).map((text) => ({ text }));
  const needsReport = routed && (!reported || reported.outcome !== outcome || findings.trim() !== reportedFindings.trim());
  const basis = JSON.stringify([detail.revision, task.work_revision, action, reason, evidence, routed ? [outcome, findings] : null]);
  const current = preview?.basis === basis ? preview.detail : null;
  const invalid = permission(detail) || (action === "accept"
    ? !detail.evidence_capability?.available || !evidence || evidence.evidence_set_id !== task.current_evidence_set_id
      ? "Read and select the current saved evidence before accepting."
      : supplierRequired && !supplier ? "Result supplier attribution is unavailable. This outside result cannot be accepted safely."
      : routed && !outcomes.some((o) => o.name === outcome) ? "Choose this step’s outcome before accepting. Its rule decides what happens next." : null
    : !reason.trim() ? "Explain what needs to change before requesting changes." : null);

  async function review() {
    if (busy || stale || unresolved || invalid) return;
    setBusy(true); setPreview(null); setError("");
    try {
      const latest = await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity });
      const blocked = permission(latest);
      if (blocked) throw new Error(blocked);
      const target = latest.tasks.find((t) => t.id === task.id)!;
      if (latest.revision !== detail.revision || target.work_revision !== task.work_revision) {
        throw new Error("The task changed. Refresh it and review the current result; your feedback is kept.");
      }
      if (action === "accept") {
        const saved = await workflowRequest("WorkflowTaskEvidence", workflowPaths.detail(detail.id) + `/tasks/${encodeURIComponent(task.id)}/evidence`, { actorId: scope.identity });
        const selected = saved.sets.find((set) => set.evidence_set_id === evidence?.evidence_set_id);
        const refreshedSupplier = selected ? evidenceSupplier(selected) : { required: false, supplier: null };
        if (!latest.evidence_capability?.available || saved.task_id !== task.id || saved.workflow_id !== detail.id || !selected
          || selected.task_id !== task.id || selected.workflow_id !== detail.id
          || saved.current_evidence_set_id !== target.current_evidence_set_id || selected.evidence_set_id !== target.current_evidence_set_id
          || !evidenceUsable(selected, target.work_revision) || JSON.stringify(evidenceReference(selected)) !== JSON.stringify(evidence)
          || refreshedSupplier.required !== supplierRequired || JSON.stringify(refreshedSupplier.supplier) !== JSON.stringify(supplier)) {
          setEvidence(null); setSupplier(null); setSupplierRequired(false);
          throw new Error("The saved evidence changed or is unavailable. Read the current files and select them again.");
        }
        if (refreshedSupplier.required && !refreshedSupplier.supplier) {
          throw new Error("Result supplier attribution is unavailable. This outside result cannot be accepted safely.");
        }
      }
      const route = routed ? await workflowRequest("RoutingPreview", `/api/tasks/${encodeURIComponent(task.id)}/outcome/preview`,
        { method: "POST", body: { outcome, expected_work_revision: task.work_revision }, actorId: scope.identity }) : null;
      setPreview({ detail: latest, basis, route });
    } catch (e) { setError(e instanceof Error ? e.message : "The result could not be checked. Your feedback is kept."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!current || invalid || stale || unresolved || busy || permission(current)) return;
    let base = current;
    if (needsReport) {
      // The outcome is recorded first; acceptance then applies its rule against the new revision.
      const report = await sendWorkflowOperation(scope, slot, { operation: "report_outcome", expectedWorkflowId: detail.id,
        url: `/api/tasks/${encodeURIComponent(task.id)}/outcome`, body: {
          expected_revision: current.revision, expected_work_revision: task.work_revision, outcome, findings: findingList,
          note: reason.trim() || reported?.note || "",
        } });
      if (report.state !== "saved" || !report.result) { setPreview(null); return; }
      base = report.result;
    }
    const result = await sendWorkflowOperation(scope, slot, { operation: action, expectedWorkflowId: detail.id,
      url: `/api/tasks/${encodeURIComponent(task.id)}/${action}`, body: {
        expected_revision: base.revision, expected_work_revision: task.work_revision, reason: reason.trim(),
        ...(action === "accept" ? { evidence } : {}),
      } });
    setPreview(null);
    if (result.state === "saved" && result.result) onSaved(result.result);
  }
  return <section aria-label={`Review result for ${task.title}`} className="wf-form-body">
    <h3>Review finished work</h3>
    <p>Done when: {task.definition_of_done}</p>
    <p>This decision is about the finished result, separate from its plan approval. Accepting a result never finishes the workflow.</p>
    <div className="wf-review">
    <div className="wf-review-evidence">
    <fieldset disabled={busy || unresolved || stale || !!permission(detail)}><legend>Saved result to review</legend>
      <WorkflowEvidencePanel key={`${detail.id}:${task.id}:${task.work_revision}:${task.current_evidence_set_id}`} detail={detail} taskId={task.id}
        selected={evidence?.evidence_set_id} onSelect={action === "accept" ? (next, _revision, selected) => {
          const attribution = selected ? evidenceSupplier(selected) : { required: false, supplier: null };
          setEvidence(next); setSupplier(attribution.supplier); setSupplierRequired(attribution.required); setPreview(null);
        } : undefined} />
    </fieldset>
    </div>
    <div className="wf-review-decision">
    <fieldset disabled={busy || unresolved || stale}><legend>Decision</legend>
      <label className="wf-choice"><input type="radio" name={`decision-${task.id}`} checked={action === "accept"} onChange={() => setAction("accept")} />Accept result</label>
      <label className="wf-choice"><input type="radio" name={`decision-${task.id}`} checked={action === "reject"} onChange={() => setAction("reject")} />Request changes</label>
      <label>{action === "reject" ? "What needs to change" : "Review note (optional)"}<textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </fieldset>
    {routed && <fieldset disabled={busy || unresolved || stale}><legend>Outcome</legend>
      <p>{reported ? `${reported.reporter_kind === "human" ? "A person" : "The step"} reported “${reported.outcome}”. Change it here if the result says otherwise.`
        : "This step should report an outcome, and none was reported. Choose the one this result reached."}</p>
      {outcomes.map((o) => <label key={o.name} className="wf-choice"><input type="radio" name={`outcome-${task.id}`} checked={outcome === o.name} onChange={() => setOutcome(o.name)} />
        <span>{o.name}<small>{routeLine(o.name)}</small></span></label>)}
      <label className="wf-field">Findings (one per line)<textarea maxLength={4000} value={findings} onChange={(e) => setFindings(e.target.value)} /></label>
      <p className="wf-muted">Reporting cannot change what “done” means for any step. Changing success criteria goes through the owner.</p>
    </fieldset>}
    {routed && !current && live && <RoutePreview route={live} detail={detail} findings={findingList.length} reporting={false} />}
    {action === "accept" && supplierRequired && supplier && <p>Result supplied by {supplier.alias} ({supplier.kind === "human" ? "person" : "agent"}). {supplier.id === scope.identity
      ? "You supplied this outside result; accepting your own result is allowed and will be recorded."
      : "The supplier and acceptor will be recorded separately."}</p>}
    {invalid && <p>{invalid}</p>}{error && <p role="alert">{error}</p>}
    <Button disabled={busy || stale || unresolved || !!invalid} onClick={() => void review()}>{busy ? "Checking result…" : "Review decision"}</Button>
    {current && <>
      <p>{action === "accept" ? `Accept work revision ${task.work_revision} with ${evidence?.items.length} exact saved file versions. Holds and worker shutdown rules remain in effect.`
        : "Your feedback is recorded against this result. The owner decides what happens next; this does not restart the agent. A running worker must still stop."}</p>
      {preview?.route && <RoutePreview route={preview.route} detail={current} findings={findingList.length} reporting={needsReport} />}
      <Button variant={action === "reject" ? "danger" : "primary"} disabled={busy || stale || unresolved || !!invalid || !!permission(current)} onClick={() => void confirm()}>
        {action === "accept" ? "Confirm accept result" : "Confirm request changes"}
      </Button>
    </>}
    </div></div>
    <WorkflowOperationNotice scope={scope} slot={slot} onSaved={onSaved} canRetry={async () => {
      const verb = operation?.operation;
      const path = verb === "report_outcome" ? "outcome" : verb;
      if (!operation || (verb !== "accept" && verb !== "reject" && verb !== "report_outcome") || operation.url !== `/api/tasks/${encodeURIComponent(task.id)}/${path}` || stale) return false;
      return !permission(await workflowRequest("WorkflowDetail", workflowPaths.detail(detail.id), { actorId: scope.identity }), verb === "reject" ? "reject" : "accept");
    }} />
  </section>;
}

/** What accepting with this outcome does next, from the server's read-only routing preview:
 * each affected step with whether it repeats, goes stale, is not selected or is kept (#362 x06). */
function RoutePreview({ route, detail, findings, reporting }: { route: RoutingPreview; detail: WorkflowDetail; findings: number; reporting: boolean }) {
  const title = (id?: string | null) => detail.tasks.find((t) => t.id === id)?.title ?? "a removed step";
  const heading = {
    return: `This sends work back to ${title(route.destination_task_id)}`, step: `This moves on to ${title(route.destination_task_id)}`,
    next: "This moves on to the next steps", ask_owner: "This asks the owner what happens next", exit_group: "This ends the loop", stop: "This stops the workflow",
  }[route.destination];
  const next = (route.round ?? 0) + 1;
  const carried = findings ? ` with ${findings === 1 ? "your finding" : `your ${findings} findings`}` : "";
  const rows: [string, string, "warn" | "neutral" | "ok", string][] = [
    ...(route.repeats ?? []).map((id): [string, string, "warn", string] => [id, `${title(id)} · repeats in round ${next}${id === route.destination_task_id ? carried : ""}`, "warn", "Repeats"]),
    ...(route.stale ?? []).map((id): [string, string, "warn", string] => [id, `${title(id)} · built on work that goes back · will need redoing`, "warn", "Stale"]),
    ...(route.not_selected ?? []).map((id): [string, string, "neutral", string] => [id, `${title(id)} · not on this path`, "neutral", "Not selected"]),
    ...(route.kept ?? []).map((id): [string, string, "ok", string] => [id, `${title(id)} · unchanged`, "ok", "Kept"]),
  ];
  return <div aria-label="What happens next">
    <div className="wf-impact">
      <div className="wf-impact-h"><span>{heading}</span><span>preview</span></div>
      {reporting && <div className="wf-impact-row"><span className="t">Records the outcome “{route.outcome}”, then accepts.</span></div>}
      {route.blocked_by === "limit" && <div className="wf-impact-row"><span className="t">The loop is at its round limit, so the owner decides instead of starting round {next}.</span><Badge tone="warn">Owner decides</Badge></div>}
      {rows.map(([id, text, tone, label]) => <div key={`${label}-${id}`} className="wf-impact-row"><span className="t">{text}</span><Badge tone={tone}>{label}</Badge></div>)}
      {!rows.length && !reporting && route.blocked_by !== "limit" && <div className="wf-impact-row"><span className="t">{route.message}</span></div>}
    </div>
    {route.destination === "return" && route.round != null && <p className="wf-muted">Nothing is deleted. Round {route.round} results stay in Review history.{route.blocked_by !== "limit" && route.rounds_remaining != null ? ` Rounds remaining after this: ${Math.max(route.rounds_remaining - 1, 0)}.` : ""}</p>}
  </div>;
}
