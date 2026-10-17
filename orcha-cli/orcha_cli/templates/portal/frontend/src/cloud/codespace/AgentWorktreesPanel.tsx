/**
 * Code Space › Changes › Agent worktrees (GH #288): the project's task worktrees (from the host
 * notifier's inventory) with "Bring in" (worktree → main) and "Update" (main → worktree). Both
 * open the shared BringInDialog (a dry run first). Disabled while the agent runs in that
 * worktree; available again when its run finishes.
 */
import { useCallback, useEffect, useState } from "react";
import { getJSON } from "../../api/client";
import { Button, Chip, Tooltip } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { BringInDialog, type BringInDirection } from "../../pages/settings/BringInDialog";
import { STATE_META, type WorktreeItem, type WorktreesPayload } from "../../pages/settings/AgentWorktreesSection";

const REFRESH_MS = 30_000;

/** Task worktrees only, running ones last (pure, tested). */
export function taskWorktrees(items: WorktreeItem[] | undefined | null): WorktreeItem[] {
  return (items || []).filter((i) => i.kind === "task" && i.state !== "not-quorate")
    .sort((a, b) => Number(a.state === "in-use") - Number(b.state === "in-use") || (a.agent || "").localeCompare(b.agent || ""));
}

export function AgentWorktreesPanel({ cid, writeBlock, onChanged }: { cid: string; writeBlock: string | null; onChanged?: () => void }) {
  const [items, setItems] = useState<WorktreeItem[] | null>(null);
  const [open, setOpen] = useState<{ item: WorktreeItem; direction: BringInDirection } | null>(null);
  const base = "/api/containers/" + encodeURIComponent(cid) + "/agent-worktrees";

  const load = useCallback(() => {
    getJSON<WorktreesPayload>(base)
      .then((d) => setItems(d?.inventory?.items ?? []))
      .catch(() => setItems((prev) => prev ?? []));
  }, [base]);

  useEffect(() => {
    load();
    const id = window.setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const rows = taskWorktrees(items);
  if (!rows.length) return null;
  return (
    <section className="cs-agent-wts" aria-label="Agent worktrees">
      <div className="cs-agent-wts-h">Agent worktrees</div>
      <ul className="cs-agent-wts-list">
        {rows.map((it) => {
          const running = it.state === "in-use";
          const why = writeBlock || (running ? "Available when the agent's run finishes" : null);
          return (
            <li key={it.path} className="cs-agent-wt" data-state={it.state}>
              <div className="cs-agent-wt-main">
                <span className="cs-agent-wt-who">{it.agent || "—"}</span>
                <span className="cs-agent-wt-task" title={it.task_title || undefined}>{it.task_title || it.name}</span>
                <span className="cs-agent-wt-meta">
                  <Chip size="sm" dot={STATE_META[it.state].tone}>{STATE_META[it.state].label}</Chip>
                  {it.last_activity_at ? <span className="cs-agent-wt-age">{relTime(it.last_activity_at)}</span> : null}
                </span>
              </div>
              <span className="cs-agent-wt-acts">
                <Tooltip label={why || "Bring this worktree's changes into main (dry run first)"} placement="top">
                  <Button size="sm" variant="secondary" pill aria-label={"Bring in " + it.name} disabled={!!why}
                    onClick={() => setOpen({ item: it, direction: "bring_in" })}>Bring in</Button>
                </Tooltip>
                <Tooltip label={why || "Bring main's changes into this worktree (dry run first)"} placement="top">
                  <Button size="sm" variant="ghost" pill aria-label={"Update " + it.name + " from main"} disabled={!!why}
                    onClick={() => setOpen({ item: it, direction: "update_from_main" })}>Update</Button>
                </Tooltip>
              </span>
            </li>
          );
        })}
      </ul>
      {open ? (
        <BringInDialog cid={cid} item={open.item} direction={open.direction}
          onClose={() => setOpen(null)} onDone={() => { load(); onChanged?.(); }} />
      ) : null}
    </section>
  );
}
