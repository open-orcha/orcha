import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Button } from "../../components/primitives/Button";
import { Shell } from "../../shell/Shell";
import { useSnapshot } from "../../state/SnapshotProvider";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import "./workflows.css";

/** Temporary integration boundary. Route discovery is NOT authorization.
 * No proposed workflow endpoint is called until its generated contract lands. */
type Availability = "checking" | "unsupported" | "awaiting_adapter" | "unavailable";

export function hasWorkflowRoutes(spec: unknown): boolean {
  if (!spec || typeof spec !== "object" || !("paths" in spec) || !spec.paths || typeof spec.paths !== "object") throw new Error("OpenAPI paths unavailable");
  return Object.entries(spec.paths).some(([path, operations]) => /^\/api\/containers\/\{[^}]+\}\/workflows$/.test(path)
    && operations !== null && typeof operations === "object" && "get" in operations);
}

export function WorkflowsPage() {
  const { cid, identity, identityTrusted, identityPending } = useSnapshot();
  const { pathname } = useLocation();
  const [result, setResult] = useState<{ cid: string; availability: Availability } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!cid) return;
    const controller = new AbortController();
    let active = true;
    setResult({ cid, availability: "checking" });
    const timeout = setTimeout(() => {
      if (active) setResult({ cid, availability: "unavailable" });
      controller.abort();
    }, 10_000);
    getJSON<unknown>("/openapi.json", controller.signal).then((spec) => {
      if (active && !controller.signal.aborted) setResult({ cid, availability: hasWorkflowRoutes(spec) ? "awaiting_adapter" : "unsupported" });
    }).catch(() => {
      if (active && !controller.signal.aborted) setResult({ cid, availability: "unavailable" });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [cid, retry]);
  const availability = result?.cid === cid ? result.availability : "checking";
  const message = availability === "checking" ? "Checking Workflows support…"
    : availability === "unsupported" ? "This Orcha server doesn’t support Workflows yet. Your existing tasks are still available."
    : availability === "unavailable" ? "Workflows support could not be checked. Check your connection to Orcha and try again."
    : "This portal version cannot use this server’s Workflows features yet. Your existing tasks are still available.";
  const isNew = pathname === "/workflows/new";

  return <Shell page="workflows" title="Workflows"><div className="wf-page">
    <div className="wf-notice" role="status"><p>{cid ? message : "Choose a project to view Workflows."}</p></div>
    <div className="wf-actions">
      {cid && availability !== "checking" && <Button onClick={() => setRetry((n) => n + 1)}>Check again</Button>}
      <Link to={cid ? `/tasks?${new URLSearchParams({ cid })}` : "/tasks"}>Open tasks</Link>
    </div>
    {isNew && cid && !identityPending && identityTrusted && identity?.agent_id && <WorkflowDraftEditor
      scope={{ origin: window.location.origin, project: cid, identity: identity.agent_id }} saveUnavailableReason={message} />}
    {isNew && (!identityTrusted || !identity?.agent_id || identityPending) && <p>Verified sign-in is required before preparing a workflow draft. Selecting a human name does not verify sign-in.</p>}
  </div></Shell>;
}
