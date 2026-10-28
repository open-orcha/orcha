import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSnapshot } from "../../state/SnapshotProvider";
import { workflowPaths, workflowRequest } from "./workflowApi";
import { workflowNavigationState } from "./workflowNavigation";

export function WorkflowTaskLink({ cid, taskId, children }: { cid: string; taskId: string; children: ReactNode }) {
  const location = useLocation();
  const query = new URLSearchParams({ task: taskId, cid });
  if (/^\/workflows\/[^/]+$/.test(location.pathname) && location.pathname !== "/workflows/new") query.set("workflowReturn", location.pathname + location.search);
  return <Link to={`/tasks?${query}`} state={workflowNavigationState(location.state)}>{children}</Link>;
}

export function workflowReturnTarget(raw: string | null, cid: string): { id: string; href: string } | null {
  if (!raw || !raw.startsWith("/workflows/") || raw.includes("\\")) return null;
  const url = new URL(raw, "https://local.invalid");
  const match = /^\/workflows\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
  if (!match || match[1] === "new" || url.origin !== "https://local.invalid" || url.searchParams.get("cid") !== cid) return null;
  // Only known workflow navigation state survives; never redirect to an arbitrary URL.
  const query = new URLSearchParams({ cid });
  const tab = url.searchParams.get("tab");
  if (tab && ["tasks", "dependencies", "review", "activity"].includes(tab)) query.set("tab", tab);
  return { id: match[1], href: `${url.pathname}?${query}` };
}

export function WorkflowTaskReturn({ taskId }: { taskId: string }) {
  const { cid, identity } = useSnapshot();
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get("workflowReturn");
  const [name, setName] = useState<string | null>(null);
  const target = cid ? workflowReturnTarget(raw, cid) : null;
  useEffect(() => {
    setName(null);
    if (!target) return;
    const controller = new AbortController(); let active = true;
    void workflowRequest("WorkflowDetail", workflowPaths.detail(target.id), { signal: controller.signal }).then((detail) => {
      if (active && !detail.hidden && detail.id === target.id && detail.container_id === cid && detail.capability.workflow_read && detail.tasks.some((t) => t.id === taskId)) setName(detail.title);
    }).catch(() => { /* An invalid/stale return hint never grants membership or hides the task. */ });
    return () => { active = false; controller.abort(); };
  }, [target?.id, cid, taskId, identity?.agent_id]);
  return target && name ? <p><Link to={target.href} state={workflowNavigationState(location.state)}>Back to {name}</Link></p> : null;
}
