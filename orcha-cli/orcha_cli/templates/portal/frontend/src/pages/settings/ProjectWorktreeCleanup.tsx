import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Button } from "../../components/primitives";
import { formatSize } from "../../lib/format";
import { settingsErrText, StatusLine } from "./settingsUi";

interface CleanupResult {
  plan_id: string;
  status: string;
  scanned: number;
  total: number;
  candidate_count: number;
  candidate_bytes: number;
  unknown_sizes: number;
  error?: string | null;
  removed: unknown[];
  items: Array<{ path: string; name: string; state: string; reason: string; outcome?: string;
    unmerged_commits?: number | null; output_count?: number; discarded_caches?: string[]; saved_to?: string }>;
}
interface Action { id: string; status: string; result: CleanupResult | null; error?: string | null }

export function ProjectWorktreeCleanup({ cid, humanId, locked }: {
  cid: string; humanId?: string; locked: boolean;
}) {
  const base = `/api/containers/${cid}/agent-worktrees`;
  const [action, setAction] = useState<Action | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = starting || action?.status === "requested" || action?.status === "claimed";
  useEffect(() => {
    if (!action || !pending || starting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getJSON<Action>(`${base}/actions/${action.id}`);
        if (!cancelled) {
          setAction(next);
          if (next.status === "requested" || next.status === "claimed") timer = setTimeout(poll, 1500);
        }
      } catch (e) {
        if (!cancelled) { setError(settingsErrText(e)); timer = setTimeout(poll, 3000); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [base, action?.id, pending, starting]);
  async function start(phase: "preview" | "execute") {
    if (locked || !humanId) return;
    setStarting(true);
    setError(null);
    try {
      setAction(await sendJSON<Action>("POST", `${base}/cleanup`, {
        phase, actor_agent_id: humanId, ...(phase === "execute" ? { plan_id: action?.result?.plan_id } : {}),
      }));
    } catch (e) { setError(settingsErrText(e)); }
    finally { setStarting(false); }
  }
  const result = action?.result;
  return <section aria-label="Project-wide worktree cleanup" className="wtg-summary">
    <p>Clean up inactive worktrees anywhere in this project. Active work and locked folders stay.
      Files are saved privately on this computer; branches and detached commits are kept.</p>
    <Button size="sm" variant="secondary" disabled={locked || pending} onClick={() => void start("preview")}>
      Preview project-wide cleanup
    </Button>
    {pending && <StatusLine tone="muted">{result ? `Checked ${result.scanned} of ${result.total} folders` : "Waiting for the host to scan…"}</StatusLine>}
    {(error || action?.error || result?.error) && <StatusLine tone="err">{error || action?.error || result?.error}</StatusLine>}
    {result && <>
      <p>{result.candidate_count} eligible folders · {formatSize(result.candidate_bytes)} before saving files
        {result.unknown_sizes ? ` · ${result.unknown_sizes} sizes unavailable` : ""}.
        Saved files still use disk space; the final amount reclaimed may be smaller.</p>
      <ul aria-label="Project cleanup preview">{result.items.map(row => <li key={row.path}>
        <span title={row.path}>{row.name}</span>: {row.outcome || row.state} — {row.reason}
        {row.unmerged_commits ? ` · ${row.unmerged_commits} unmerged commits kept` : ""}
        {row.output_count ? ` · ${row.output_count} files to preserve` : ""}
        {row.discarded_caches?.length ? <div>Dependency/cache folders not saved: {row.discarded_caches.join(", ")}</div> : null}
        {row.saved_to ? <div>Saved at {row.saved_to}</div> : null}
      </li>)}</ul>
      {!pending && action?.status === "done" && result.status === "ready" && result.candidate_count > 0 &&
        <Button size="sm" variant="primary" disabled={locked} onClick={() => void start("execute")}>
          Save work and remove {result.candidate_count} folders
        </Button>}
      {result.status === "done" && <StatusLine tone="ok">Removed {result.removed.length} folders. Anything that changed since preview was retained.</StatusLine>}
    </>}
  </section>;
}
