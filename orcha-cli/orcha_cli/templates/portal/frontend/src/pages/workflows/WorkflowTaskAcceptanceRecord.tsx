import type { WorkflowTask } from "./workflowContract.generated";

export function acceptanceAttributionUnavailable(task: WorkflowTask): boolean {
  return !!task.acceptance?.evidence_items.some((item) => !item.source || ["outside", "owner"].includes(item.source));
}

/** Display the recorded actor and exact files, never the current owner,
 * assignee, newest file, or a worker's diagnostics. */
export function WorkflowTaskAcceptanceRecord({ task }: { task: WorkflowTask }) {
  const acceptance = task.acceptance;
  if (!acceptance) return <p>No result acceptance is recorded for this work revision.</p>;
  return <section aria-label={`Recorded acceptance for ${task.title}`}>
    <h3>Recorded acceptance — {task.title}</h3>
    <p>Accepted by {acceptance.actor_alias} ({acceptance.actor_kind === "human" ? "person" : "agent"}) for work revision {acceptance.work_revision} on <time dateTime={acceptance.accepted_at}>{new Date(acceptance.accepted_at).toLocaleString()}</time>.</p>
    <p>Task autonomy {acceptance.autonomy_at_acceptance.toUpperCase()} at acceptance · setting revision {acceptance.autonomy_revision}.</p>
    <p>{acceptance.actor_kind === "ai" && acceptance.autonomy_at_acceptance === "on" ? "Agent acceptance authorized by task autonomy."
      : acceptance.actor_kind === "human" ? "Human acceptance." : "Recorded authority needs review; this record does not establish valid agent acceptance."}</p>
    {acceptanceAttributionUnavailable(task) && <p>Result supplier attribution is unavailable on this server version. It cannot establish whether the same person supplied and accepted this result.</p>}
    <ul>{acceptance.evidence_items.map((item) => <li key={item.item_id}>
      <a href={`/api/tasks/${encodeURIComponent(task.id)}/deliverables/${encodeURIComponent(item.deliverable_id)}/versions/${item.deliverable_version}/raw`}>Accepted evidence — version {item.deliverable_version}</a>
      {item.storage_state && item.storage_state !== "readable" && <p>Accepted file {item.storage_state.replaceAll("_", " ")}. Restore this exact version before further acceptance or Finish.</p>}
      <details><summary>Recorded file fingerprint</summary><p className="wf-fingerprint">SHA-256 {item.sha256}</p></details>
    </li>)}</ul>
    <details><summary>Acceptance source</summary><p>{acceptance.acceptance_source}</p></details>
    <p>These are the accepted file versions. If a file is unavailable, restore that exact file; newer evidence does not replace this record.</p>
  </section>;
}
