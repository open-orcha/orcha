import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/primitives/Button";
import { getJSON } from "../../api/client";
import { useSnapshot } from "../../state/SnapshotProvider";

type DeliveryState = "deliverable_now" | "deferred_until_eligible" | "worker_running" | "no_assignee"
  | "task_finished" | "wake_disabled_or_paused" | "unknown";
export interface MessageDelivery {
  task_id: string;
  state: DeliveryState;
  reason: string;
  task_href: string;
  recipients: { agent_id: string; alias: string; state: DeliveryState; reason: string; direct_chat_href: string | null }[];
}
const labels: Record<DeliveryState, string> = {
  deliverable_now: "Can request a wake", deferred_until_eligible: "Message waits",
  worker_running: "Agent already running", no_assignee: "No assignee", task_finished: "Task finished",
  wake_disabled_or_paused: "Automatic work unavailable", unknown: "Delivery not confirmed",
};

/** Shared by the task and workflow composers. Reads once and after a successful
 * send; never adds expensive workflow eligibility reads to message polling. */
export function TaskMessageDelivery({ taskId, sent = 0 }: { taskId: string; sent?: number }) {
  const { cid, identity, identityTrusted, identityPending } = useSnapshot();
  const scope = JSON.stringify([cid, identity?.agent_id, identityTrusted, identityPending, taskId]);
  const [stored, setStored] = useState<{ scope: string; data: MessageDelivery } | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const data = stored?.scope === scope ? stored.data : null;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setStored(null); setFailed(false);
    void getJSON<MessageDelivery>(`/api/tasks/${encodeURIComponent(taskId)}/messages/delivery`, controller.signal)
      .then((next) => {
        if (next.task_id !== taskId || !Array.isArray(next.recipients) || !(next.state in labels)) throw new Error("Invalid delivery guidance");
        if (active) setStored({ scope, data: next });
      }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; controller.abort(); };
  }, [scope, taskId, sent, refresh]);
  return <aside aria-label="Message delivery" className="task-message-delivery">
    <p>{sent > 0 ? "Message saved. Saving does not mean the agent has answered." : "Messages are saved here. Saving does not mean the agent has answered."}</p>
    {!data && <p>{failed ? "Delivery could not be checked. Open the assigned agent’s direct chat and include this task’s link if you need an answer now." : "Checking message delivery…"}</p>}
    {data && <>
      {!data.recipients.length && <p>{labels[data.state]}: {data.reason}</p>}
      {data.recipients.map((recipient) => <p key={recipient.agent_id}>
        <strong>{recipient.alias}: {labels[recipient.state] ?? labels.unknown}.</strong> {recipient.reason}{" "}
        {recipient.direct_chat_href && <><Link to={recipient.direct_chat_href}>Open {recipient.alias}’s direct chat</Link> and include <Link to={data.task_href}>this task’s link</Link> if you need an answer now.</>}
      </p>)}
    </>}
    <Button size="sm" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>Check message delivery</Button>
  </aside>;
}
