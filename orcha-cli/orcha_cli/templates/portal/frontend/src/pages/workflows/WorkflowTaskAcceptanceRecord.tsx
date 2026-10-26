import type { WorkflowTask } from "./workflowContract.generated";

export function acceptanceAttributionUnavailable(task: WorkflowTask): boolean {
  if (!task.acceptance || task.acceptance.acceptance_source === "import") return false;
  return task.acceptance.evidence_items.some((item) => !item.source
    || (["outside", "owner"].includes(item.source)
      && (!item.captured_by || !item.captured_by_alias || !item.captured_by_kind)));
}

export function samePersonOutsideAcceptance(task: WorkflowTask): boolean {
  const acceptance = task.acceptance;
  return !!acceptance && acceptance.acceptance_source !== "import"
    && acceptance.evidence_items.some((item) => ["outside", "owner"].includes(item.source ?? "")
      && item.captured_by === acceptance.actor_id);
}

function recordedSuppliers(task: WorkflowTask) {
  if (!task.acceptance || task.acceptance.acceptance_source === "import") return [];
  const unique = new Map<string, { id: string; alias: string; kind: "human" | "ai" }>();
  for (const item of task.acceptance.evidence_items) {
    if (item.captured_by && item.captured_by_alias && item.captured_by_kind) {
      if (!unique.has(item.captured_by)) unique.set(item.captured_by, {
        id: item.captured_by, alias: item.captured_by_alias, kind: item.captured_by_kind,
      });
    }
  }
  return [...unique.values()];
}

/** Display the recorded actor and exact files, never the current owner,
 * assignee, newest file, or a worker's diagnostics. */
export function WorkflowTaskAcceptanceRecord({ task }: { task: WorkflowTask }) {
  const acceptance = task.acceptance;
  if (!acceptance) return <p>No result acceptance is recorded for this work revision.</p>;
  const imported = acceptance.acceptance_source === "import";
  const suppliers = recordedSuppliers(task);
  return <section aria-label={`Recorded acceptance for ${task.title}`}>
    <h3>Recorded acceptance — {task.title}</h3>
    <p>Accepted by {acceptance.actor_alias} ({acceptance.actor_kind === "human" ? "person" : "agent"}) for work revision {acceptance.work_revision} on <time dateTime={acceptance.accepted_at}>{new Date(acceptance.accepted_at).toLocaleString()}</time>.</p>
    <p>Task autonomy {acceptance.autonomy_at_acceptance.toUpperCase()} at acceptance · setting revision {acceptance.autonomy_revision}.</p>
    <p>{acceptance.actor_kind === "ai" && acceptance.autonomy_at_acceptance === "on" ? "Agent acceptance authorized by task autonomy."
      : acceptance.actor_kind === "human" ? "Human acceptance." : "Recorded authority needs review; this record does not establish valid agent acceptance."}</p>
    {imported && <p>Completed before it joined this workflow; reviewed and accepted on import by {acceptance.actor_alias}.</p>}
    {!imported && suppliers.map((supplier) => <p key={supplier.id}>Submitted by {supplier.alias} (verified).</p>)}
    {samePersonOutsideAcceptance(task) && <p>Owner-supplied result, accepted by the same person.</p>}
    {acceptanceAttributionUnavailable(task) && <p>Result supplier attribution was not recorded with this acceptance. Finish stays unavailable because Orcha cannot verify who submitted it. There is no supported recovery path for this legacy record yet.</p>}
    <ul>{acceptance.evidence_items.map((item) => <li key={item.item_id}>
      <a href={`/api/tasks/${encodeURIComponent(task.id)}/deliverables/${encodeURIComponent(item.deliverable_id)}/versions/${item.deliverable_version}/raw`}>Accepted evidence — version {item.deliverable_version}</a>
      {item.storage_state && item.storage_state !== "readable" && <p>Accepted file {item.storage_state.replaceAll("_", " ")}. Restore this exact version before further acceptance or Finish.</p>}
      <details><summary>Recorded file fingerprint</summary><p className="wf-fingerprint">SHA-256 {item.sha256}</p></details>
    </li>)}</ul>
    <details><summary>Acceptance source</summary><p>{acceptance.acceptance_source}</p></details>
    <p>These are the accepted file versions. If a file is unavailable, restore that exact file; newer evidence does not replace this record.</p>
  </section>;
}
