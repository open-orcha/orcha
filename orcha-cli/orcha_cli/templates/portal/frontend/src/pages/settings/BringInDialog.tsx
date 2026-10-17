/**
 * GH #288 — "Bring changes into main" / "Update from main" for ONE task worktree.
 *
 * The host notifier does every git operation (POST …/agent-worktrees/actions with
 * action=bring_in | update_from_main; the portal records the request, the daemon reports).
 * The dialog always files a DRY RUN first and shows its plan — the files that would change,
 * conflicts (then nothing is applied; the agent can be asked to resolve them in its own
 * worktree), whether main moved ahead, whether the receiving checkout has uncommitted files
 * (stash offered, named by the human), whether main is on another branch (must be confirmed),
 * and the result form (apply as uncommitted changes, or merge the branch). The real run only
 * carries the human's confirmed choices. Shared by Settings › Agent worktrees, Code Space and
 * the Agents page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { useToast } from "../../components/ui";
import { Button, Dialog } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { agentByAlias, useSnapshot } from "../../state/SnapshotProvider";
import { useGrantAuthority } from "./grantAuthority";
import { settingsErrText } from "./settingsUi";
import type { WorktreeAction, WorktreeItem } from "./AgentWorktreesSection";

export type BringInDirection = "bring_in" | "update_from_main";

export interface BringInOptions {
  dry_run: boolean;
  mode: "apply" | "merge";
  stash: boolean;
  stash_message: string | null;
  allow_other_branch: boolean;
}

/** The daemon's dry-run report (orcha_cli/worktree_bringin.plan_*). */
export interface BringInPlan {
  direction: "bring_in" | "update";
  mode?: "apply" | "merge";
  name: string;
  branch: string;
  base_branch: string;
  main_branch: string | null;
  main_ahead?: boolean;
  other_branch?: boolean;
  main_dirty: string[];
  agent_dirty: string[];
  needs_stash: boolean;
  files: { status: string; path: string; from?: string }[];
  file_count: number;
  conflicts: string[];
  error: string | null;
  nothing_to_do: boolean;
  commits_behind?: number;
  last_applied_at?: string | null;
  incremental?: boolean;
  // the real run adds:
  outcome?: "done" | "nothing-to-do" | "failed";
  stash?: string | null;
  stash_restore?: "restored" | "kept" | null;
  wip_commit?: string | null;
  merge_commit?: string | null;
}

const POLL_MS = 2000;
const POLL_MAX = 150;

/** The daemon's report, with every list present (an older daemon or a refusal may omit some). */
export function normalizePlan(raw: unknown): BringInPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BringInPlan>;
  return {
    direction: r.direction || "bring_in", mode: r.mode, name: r.name || "", branch: r.branch || "",
    base_branch: r.base_branch || "main", main_branch: r.main_branch ?? null, main_ahead: !!r.main_ahead,
    other_branch: !!r.other_branch, main_dirty: r.main_dirty || [], agent_dirty: r.agent_dirty || [],
    needs_stash: !!r.needs_stash, files: r.files || [], file_count: r.file_count ?? (r.files || []).length,
    conflicts: r.conflicts || [], error: r.error ?? null, nothing_to_do: !!r.nothing_to_do,
    commits_behind: r.commits_behind, last_applied_at: r.last_applied_at ?? null, incremental: !!r.incremental,
    outcome: r.outcome, stash: r.stash ?? null, stash_restore: r.stash_restore ?? null,
    wip_commit: r.wip_commit ?? null, merge_commit: r.merge_commit ?? null,
  };
}

/** File one request and poll it until the notifier reports back (shared with the section). */
export async function runWorktreeAction(
  base: string, body: Record<string, unknown>, alive: () => boolean = () => true,
): Promise<WorktreeAction> {
  let a = await sendJSON<WorktreeAction>("POST", base + "/actions", body);
  for (let i = 0; i < POLL_MAX && (a.status === "requested" || a.status === "claimed"); i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!alive()) break;
    a = await getJSON<WorktreeAction>(base + "/actions/" + encodeURIComponent(a.id));
  }
  return a;
}

/** The dialog's verdict on a plan (pure, tested): what to say and whether Confirm is allowed. */
export function planVerdict(plan: BringInPlan | null, direction: BringInDirection, opts: { stash: boolean; allowOther: boolean; mode: "apply" | "merge" }): { ok: boolean; note: string | null } {
  if (!plan) return { ok: false, note: null };
  if (plan.error) return { ok: false, note: plan.error };
  if (plan.conflicts.length) return { ok: false, note: "Conflicts — nothing is applied until they are resolved." };
  if (plan.nothing_to_do) return { ok: false, note: direction === "bring_in" ? "Main already has everything from this worktree." : "The worktree is already up to date with main." };
  if (direction === "bring_in" && plan.other_branch && !opts.allowOther) return { ok: false, note: `Main is checked out on ${plan.main_branch}, not ${plan.base_branch} — confirm applying there.` };
  if (direction === "bring_in" && opts.mode === "merge" && plan.needs_stash && !opts.stash) return { ok: false, note: "A merge needs main's uncommitted files stashed first." };
  if (direction === "update_from_main" && plan.needs_stash && !opts.stash) return { ok: false, note: "The worktree's uncommitted files must be stashed first." };
  return { ok: true, note: null };
}

export function BringInDialog({ cid, item, direction, onClose, onDone }: {
  cid: string; item: WorktreeItem; direction: BringInDirection; onClose: () => void;
  onDone?: (result: BringInPlan) => void;
}) {
  const toast = useToast();
  const { snap } = useSnapshot();
  const auth = useGrantAuthority("manage_autonomy");
  const base = "/api/containers/" + encodeURIComponent(cid) + "/agent-worktrees";
  const humanId = auth.human?.id ?? null;
  const [plan, setPlan] = useState<BringInPlan | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<"planning" | "ready" | "running" | "done">("planning");
  const [mode, setMode] = useState<"apply" | "merge">("apply");
  const [stash, setStash] = useState(true);
  const [stashMsg, setStashMsg] = useState("");
  const [allowOther, setAllowOther] = useState(false);
  const [result, setResult] = useState<BringInPlan | null>(null);
  const [asking, setAsking] = useState(false);
  const bringIn = direction === "bring_in";
  const title = bringIn ? "Bring changes into main" : "Update worktree from main";
  const agent = agentByAlias(snap, item.agent);

  // a mode change needs its own dry run (merge rehearses the branch merge, apply the delta);
  // the request names the acting human, so it waits until that is known
  useEffect(() => {
    let live = true;
    setPhase("planning");
    setPlan(null);
    setLoadErr(null);
    if (!humanId) {
      if (auth.reason) { setLoadErr(auth.reason); setPhase("ready"); }
      return () => { live = false; };
    }
    runWorktreeAction(base, { action: direction, path: item.path, actor_agent_id: humanId, options: { dry_run: true, mode } }, () => live)
      .then((a) => {
        if (!live) return;
        if (a.status === "done" && a.result) {
          setPlan(normalizePlan(a.result));
          setPhase("ready");
        } else {
          setLoadErr(a.status === "failed" ? (a.error || "the notifier couldn't rehearse it") : "the notifier hasn't answered yet — try again in a moment");
          setPhase("ready");
        }
      })
      .catch((e) => { if (live) { setLoadErr(settingsErrText(e)); setPhase("ready"); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, direction, item.path, mode, humanId]);

  const verdict = planVerdict(plan, direction, { stash, allowOther, mode });
  const confirm = async () => {
    if (!plan || !verdict.ok) return;
    setPhase("running");
    try {
      const options: BringInOptions = {
        dry_run: false, mode, stash: plan.needs_stash && stash,
        stash_message: stash && stashMsg.trim() ? stashMsg.trim() : null, allow_other_branch: allowOther,
      };
      const a = await runWorktreeAction(base, { action: direction, path: item.path, actor_agent_id: humanId, options });
      if (a.status === "done" && a.result) {
        const r = normalizePlan(a.result);
        setResult(r);
        setPhase("done");
        const n = r.file_count ?? r.files?.length ?? 0;
        toast((bringIn ? "Brought in " : "Updated with ") + n + " file" + (n === 1 ? "" : "s") + (r.stash_restore === "kept" ? " — your stash was kept" : "") + ".", r.stash_restore === "kept" ? "warn" : "ok");
        onDone?.(r);
      } else {
        setPhase("ready");
        toast("Not done — " + (a.error || "the notifier couldn't do it") + ".", "danger");
      }
    } catch (e) {
      setPhase("ready");
      toast("Couldn't send that — " + settingsErrText(e) + ".", "danger");
    }
  };

  /** Q7 follow-up: hand the conflicts to the agent in its own worktree (a direct prompt wake). */
  const askAgent = async () => {
    if (!plan || !agent) return;
    setAsking(true);
    try {
      const files = plan.conflicts.join(", ");
      const what = bringIn
        ? `Bringing your changes from worktree ${item.name} into the main checkout conflicts in: ${files}. In your worktree, merge the current base branch (${plan.base_branch}) into your branch ${plan.branch}, resolve those conflicts, and leave the result ready to bring in. Do not touch the main checkout.`
        : `Updating your worktree ${item.name} from the main checkout conflicts in: ${files}. In your worktree, merge the current base branch (${plan.base_branch}) into your branch ${plan.branch}, resolve those conflicts, and keep your own changes.`;
      await sendJSON("POST", "/api/agents/" + encodeURIComponent(agent.id) + "/prompt", { message: what, from_agent_id: humanId });
      toast(`Asked ${agent.alias} to resolve the conflicts in its worktree.`, "ok");
      onClose();
    } catch (e) {
      toast("Couldn't reach the agent — " + settingsErrText(e) + ".", "danger");
    } finally {
      setAsking(false);
    }
  };

  const target = bringIn ? "main" : item.name;
  const dirty = bringIn ? plan?.main_dirty : plan?.agent_dirty;
  const files = plan?.files || [];
  let body: ReactNode;
  if (phase === "planning") {
    body = <div className="wtg-muted" role="status">Rehearsing in a temporary worktree — nothing changes yet…</div>;
  } else if (loadErr) {
    body = <div className="wtg-muted" role="alert">Couldn't rehearse — {loadErr}.</div>;
  } else if (phase === "done" && result) {
    body = (
      <div className="wtg-files">
        <div>{result.outcome === "nothing-to-do" ? "Nothing to do." : (bringIn ? (mode === "merge" ? `Merged ${result.branch} into ${result.main_branch}.` : "The changes are in main's working tree, uncommitted — review and commit them.") : "The worktree now carries main's changes.")}</div>
        {result.stash_restore === "kept" ? (
          <div className="wtg-muted" role="alert">Your own uncommitted files could not be re-applied cleanly on top; they are kept in the stash <code>{result.stash}</code> (git stash list).</div>
        ) : result.stash ? <div className="wtg-muted">Your uncommitted files were set aside as <code>{result.stash}</code> and restored.</div> : null}
      </div>
    );
  } else if (plan) {
    body = (
      <>
        {plan.conflicts.length ? (
          <div className="wtg-files" role="alert">
            <div>Conflicts in {plan.conflicts.length} file{plan.conflicts.length === 1 ? "" : "s"} — nothing was changed:</div>
            <ul>{plan.conflicts.slice(0, 12).map((f) => <li key={f}><code>{f}</code></li>)}{plan.conflicts.length > 12 ? <li>…and {plan.conflicts.length - 12} more</li> : null}</ul>
            {agent ? <Button size="sm" variant="secondary" busy={asking} onClick={() => void askAgent()}>Ask {agent.alias} to resolve them</Button> : null}
          </div>
        ) : plan.nothing_to_do ? (
          <div className="wtg-muted">{verdict.note}</div>
        ) : (
          <div className="wtg-files">
            <div>{bringIn ? "Would change" : "Would bring"} {files.length} file{files.length === 1 ? "" : "s"}{!bringIn && plan.commits_behind ? ` (and ${plan.commits_behind} commit${plan.commits_behind === 1 ? "" : "s"} from main)` : ""}:</div>
            <ul>{files.slice(0, 12).map((f) => <li key={f.path}><code>{f.status} {f.path}</code></li>)}{files.length > 12 ? <li>…and {files.length - 12} more</li> : null}</ul>
            {plan.main_ahead && bringIn ? <div className="wtg-muted">Main moved ahead since the branch forked; the changes are replayed onto its current state.</div> : null}
            {plan.last_applied_at ? <div className="wtg-muted">Last brought in {relTime(plan.last_applied_at)} — only what changed since is carried.</div> : null}
          </div>
        )}
        {!plan.conflicts.length && !plan.nothing_to_do ? (
          <>
            {bringIn ? (
              <div className="wtg-confirm" role="radiogroup" aria-label="Result form">
                <label className="wtg-check"><input type="radio" name="bringin-mode" checked={mode === "apply"} onChange={() => setMode("apply")} /> Apply as uncommitted changes (you review and commit)</label>
                <label className="wtg-check"><input type="radio" name="bringin-mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge branch <code>{plan.branch}</code> into <code>{plan.main_branch || plan.base_branch}</code> (writes commits)</label>
              </div>
            ) : null}
            {plan.needs_stash ? (
              <div className="wtg-confirm">
                <label className="wtg-check">
                  <input type="checkbox" checked={stash} onChange={(e) => setStash(e.target.checked)} />
                  Stash the {dirty?.length ?? 0} uncommitted file{(dirty?.length ?? 0) === 1 ? "" : "s"} in {target} first (restored afterwards)
                </label>
                {dirty?.length ? <ul className="wtg-muted">{dirty.slice(0, 6).map((f) => <li key={f}><code>{f}</code></li>)}{dirty.length > 6 ? <li>…and {dirty.length - 6} more</li> : null}</ul> : null}
                {stash ? (
                  <label className="wtg-confirm">
                    <span>Stash name (so you can find it later)</span>
                    <input aria-label="Stash name" value={stashMsg} placeholder={`orcha-bring-in/${plan.name}/…`} onChange={(e) => setStashMsg(e.target.value)} />
                  </label>
                ) : null}
              </div>
            ) : null}
            {bringIn && plan.other_branch ? (
              <label className="wtg-check">
                <input type="checkbox" checked={allowOther} onChange={(e) => setAllowOther(e.target.checked)} />
                Main is on <code>{plan.main_branch}</code>, not <code>{plan.base_branch}</code> — apply there anyway
              </label>
            ) : null}
            {!verdict.ok && verdict.note ? <div className="wtg-muted">{verdict.note}</div> : null}
          </>
        ) : null}
      </>
    );
  } else {
    body = null;
  }

  return (
    <Dialog
      title={title}
      description={bringIn
        ? <>From <code>{item.branch || item.name}</code>{item.agent ? ` (${item.agent}` + (item.task_title ? ` · ${item.task_title})` : ")") : ""} into the main checkout. A dry run first; nothing is committed in main without you.</>
        : <>Main's commits and uncommitted changes into <code>{item.branch || item.name}</code>{item.agent ? ` (${item.agent})` : ""}. A dry run first.</>}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{phase === "done" ? "Close" : "Cancel"}</Button>
          {phase !== "done" ? (
            <Button variant="primary" busy={phase === "running"} disabled={!verdict.ok || phase !== "ready"} onClick={() => void confirm()}>
              {bringIn ? (mode === "merge" ? "Merge into main" : "Bring in") : "Update worktree"}
            </Button>
          ) : null}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
