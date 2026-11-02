import { useEffect, useRef, useState } from "react";
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
interface Action { id: string; status: string; result: CleanupResult | null; error?: string | null;
  created_at?: string; options?: { phase: "preview" | "execute"; plan_id: string } }

export function ProjectWorktreeCleanup({ cid, humanId, locked }: {
  cid: string; humanId?: string; locked: boolean;
}) {
  const base = `/api/containers/${cid}/agent-worktrees`;
  const [action, setAction] = useState<Action | null>(null);
  const [saved, setSaved] = useState<Action[]>([]);
  const [restoring, setRestoring] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = restoring || starting || action?.status === "requested" || action?.status === "claimed";
  function remember(next: Action) {
    setAction(next);
    setSaved(previous => [next, ...previous.filter(a => a.options?.plan_id !== next.options?.plan_id)]);
  }
  useEffect(() => {
    const current = ++generation.current;
    setAction(null); setSaved([]); setRestoring(true); setStarting(false); setRestoreFailed(false); setError(null);
    void getJSON<{ actions: Action[] }>(`${base}/cleanup`).then(data => {
      if (!Array.isArray(data?.actions)) throw new Error("Could not read saved cleanup. Please reload it.");
      if (generation.current === current) { setSaved(data.actions); setAction(data.actions[0] ?? null); }
    }).catch(e => {
      if (generation.current === current) { setRestoreFailed(true); setError(settingsErrText(e)); }
    }).finally(() => { if (generation.current === current) setRestoring(false); });
    return () => { generation.current++; };
  }, [base, reload]);
  useEffect(() => {
    if (!action || restoring || starting || (action.status !== "requested" && action.status !== "claimed")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getJSON<Action>(`${base}/actions/${action.id}`);
        if (!cancelled) {
          remember(next);
          if (next.status === "requested" || next.status === "claimed") timer = setTimeout(poll, 1500);
        }
      } catch (e) {
        if (!cancelled) { setError(settingsErrText(e)); timer = setTimeout(poll, 3000); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [base, action?.id, action?.status, restoring, starting]);
  async function start(phase: "preview" | "execute", retry = false) {
    if (locked || !humanId || pending || restoreFailed) return;
    const current = generation.current;
    setStarting(true);
    setError(null);
    try {
      const next = await sendJSON<Action>("POST", `${base}/cleanup`, {
        phase, actor_agent_id: humanId, ...((retry || phase === "execute")
          ? { plan_id: action?.options?.plan_id ?? action?.result?.plan_id } : {}),
      });
      if (generation.current === current) remember(next);
    } catch (e) { if (generation.current === current) setError(settingsErrText(e)); }
    finally { if (generation.current === current) setStarting(false); }
  }
  const result = action?.result;
  const unfinishedExecution = saved.some(a => a.options?.phase === "execute" && a.status !== "done");
  return <section aria-label="Project-wide worktree cleanup" className="wtg-summary">
    <p>Clean up inactive worktrees anywhere in this project. Active work and locked folders stay.
      Files are saved privately on this computer; branches and detached commits are kept.</p>
    {saved.length > 1 && <label>Saved cleanup <select value={action?.id ?? ""} disabled={pending}
      onChange={e => { setAction(saved.find(a => a.id === e.target.value) ?? null); setError(null); }}>
      {saved.map((a, i) => <option key={a.id} value={a.id}>
        {a.options?.phase === "execute" ? "Cleanup" : "Preview"} {i + 1} — {a.status}
        {a.created_at ? ` — ${new Date(a.created_at).toLocaleString()}` : ""}
      </option>)}
    </select></label>}
    <Button size="sm" variant="secondary" disabled={locked || pending || restoreFailed || unfinishedExecution} onClick={() => void start("preview")}>
      Preview project-wide cleanup
    </Button>
    {pending && <StatusLine tone="muted">{restoring ? "Loading saved cleanup…" : result ? `Checked ${result.scanned} of ${result.total} folders` : "Waiting for the host to scan…"}</StatusLine>}
    {restoreFailed && <Button size="sm" variant="secondary" onClick={() => setReload(n => n + 1)}>Reload saved cleanup</Button>}
    {(error || action?.error || result?.error) && <StatusLine tone="err">{error || action?.error || result?.error}</StatusLine>}
    {!pending && action?.status === "failed" && action.options &&
      <Button size="sm" variant="secondary" disabled={locked}
        onClick={() => void start(action.options!.phase, true)}>Retry interrupted cleanup</Button>}
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
