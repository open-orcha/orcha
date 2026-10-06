/**
 * Settings → Execution › Agent worktrees (mig 067, portal_backend/agent_worktree_routes.py).
 *
 * Agents work in git worktrees under <project>/.orcha-worktrees. They live on the HOST, so
 * this card shows the inventory the host notifier last reported and files requests the
 * notifier carries out (it does every git operation): remove one, save one's output to its
 * task, "Clean up now" (the clean ones), and "Clean up existing worktrees…" (a preview grouped
 * by state, then one run). The automatic clean-up switch and grace period are execution
 * settings: owner or manage_autonomy, like the rest of this tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { useToast } from "../../components/ui";
import { Button, Chip, ConfirmDialog, Tooltip, type ChipTone } from "../../components/primitives";
import { formatSize, relTime } from "../../lib/format";
import { getHost, sendToHost } from "../../state/host";
import { useGrantAuthority } from "./grantAuthority";
import { SettingRow, SettingRows, SettingsGroup, StatusLine, settingsErrText } from "./settingsUi";

export type WorktreeState = "clean" | "has-output" | "unmerged" | "in-use" | "not-quorate";

export interface WorktreeItem {
  path: string;
  name: string;
  branch: string | null;
  kind: string | null;
  agent: string | null;
  task_id?: string | null;
  task_title?: string | null;
  task_status?: string | null;
  state: WorktreeState;
  reason?: string;
  unmerged_commits?: number | null;
  output?: string[];
  modified?: string[];
  output_count?: number;
  modified_count?: number;
  size_bytes?: number | null;
  last_activity_at?: string | null;
}

export interface WorktreeAction {
  id: string;
  action: "remove" | "save_output" | "clean_up" | "refresh";
  path: string | null;
  status: "requested" | "claimed" | "done" | "failed";
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

export interface WorktreesPayload {
  settings: { auto_cleanup: boolean; grace_days: number };
  inventory: {
    host: string | null;
    scanned_at: string;
    items: WorktreeItem[];
    reclaimable_bytes: number;
    total_bytes: number;
  } | null;
  actions: WorktreeAction[];
}

export const STATE_META: Record<WorktreeState, { label: string; tone: ChipTone; order: number }> = {
  "clean": { label: "Clean", tone: "ok", order: 0 },
  "has-output": { label: "Has output", tone: "info", order: 1 },
  "unmerged": { label: "Unmerged commits", tone: "warn", order: 2 },
  "in-use": { label: "In use", tone: "accent", order: 3 },
  "not-quorate": { label: "Not an agent worktree", tone: "neutral", order: 4 },
};

const POLL_MS = 2000;
const POLL_MAX = 90;

/** Files a has-output worktree would save (pure, tested). */
export function filesToSave(it: WorktreeItem): string[] {
  return [...(it.output || []), ...(it.modified || [])];
}

/** The clean-up preview: what each group will do (pure, tested). */
export function cleanupPlan(items: WorktreeItem[], unmergedOptIn: ReadonlySet<string>) {
  const remove = items.filter((i) => i.state === "clean");
  const save = items.filter((i) => i.state === "has-output");
  const unmerged = items.filter((i) => i.state === "unmerged");
  const skipped = items.filter((i) => i.state === "in-use" || i.state === "not-quorate");
  const optIn = unmerged.filter((i) => unmergedOptIn.has(i.path));
  const freed = [...remove, ...save, ...optIn].reduce((n, i) => n + (i.size_bytes || 0), 0);
  return { remove, save, unmerged, skipped, optIn, freed };
}

function taskLabel(it: WorktreeItem): string {
  if (it.task_title) return it.task_title;
  if (it.kind === "resident") return "Conversation";
  if (it.kind === "live") return "Live terminal";
  return it.kind === "wake" ? "No task" : "";
}

function ageLabel(it: WorktreeItem): string {
  return it.last_activity_at ? relTime(it.last_activity_at) : "—";
}

export function AgentWorktreesSection({ cid }: { cid: string | null }) {
  const toast = useToast();
  const auth = useGrantAuthority("manage_autonomy");
  const locked = !auth.can;
  const [data, setData] = useState<WorktreesPayload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [grace, setGrace] = useState("7");
  const [removing, setRemoving] = useState<WorktreeItem | null>(null);
  const [preview, setPreview] = useState<"all" | "clean" | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const base = cid ? "/api/containers/" + encodeURIComponent(cid) + "/agent-worktrees" : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const d = await getJSON<WorktreesPayload>(base);
      if (!alive.current) return;
      if (!d || !d.settings) { setUnsupported(true); return; }  // an older portal
      setData(d);
      setGrace(String(d.settings.grace_days));
      setLoadErr(null);
    } catch (e) {
      if (!alive.current) return;
      if ((e as { status?: number })?.status === 404) setUnsupported(true);
      else setLoadErr(settingsErrText(e));
    }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const items = useMemo(
    () => [...(data?.inventory?.items || [])].sort((a, b) =>
      STATE_META[a.state].order - STATE_META[b.state].order || (b.size_bytes || 0) - (a.size_bytes || 0)),
    [data],
  );

  const saveSettings = async (patch: { auto_cleanup?: boolean; grace_days?: number }) => {
    if (!base || locked || !auth.human) return;
    setBusy("settings");
    try {
      const s = await sendJSON<WorktreesPayload["settings"]>("PUT", base + "/settings", { ...patch, actor_agent_id: auth.human.id });
      setData((d) => (d ? { ...d, settings: s } : d));
      setGrace(String(s.grace_days));
      toast(patch.auto_cleanup === undefined ? `Grace period set to ${s.grace_days} days.`
        : s.auto_cleanup ? "Automatic clean-up is on." : "Automatic clean-up is off.", "ok");
    } catch (e) {
      toast("Couldn't change the setting — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(null);
  };

  /** File a request, then poll it until the notifier reports back. */
  const request = async (body: Record<string, unknown>, label: string): Promise<WorktreeAction | null> => {
    if (!base || locked || !auth.human) return null;
    setBusy(label);
    try {
      let a = await sendJSON<WorktreeAction>("POST", base + "/actions", { ...body, actor_agent_id: auth.human.id });
      for (let i = 0; i < POLL_MAX && (a.status === "requested" || a.status === "claimed"); i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!alive.current) return null;
        a = await getJSON<WorktreeAction>(base + "/actions/" + encodeURIComponent(a.id));
      }
      if (a.status === "requested" || a.status === "claimed") {
        toast("Waiting for the notifier — it runs this as soon as it's back.", "warn");
      } else if (a.status === "failed") {
        toast("Not done — " + (a.error || "the notifier couldn't do it") + ".", "danger");
      }
      await load();
      return a;
    } catch (e) {
      toast("Couldn't send that — " + settingsErrText(e) + ".", "danger");
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const reveal = (it: WorktreeItem) => {
    const host = getHost();
    if (host?.capabilities.includes("revealPath")) {
      sendToHost({ type: "revealPath", path: it.path }, host);
      return;
    }
    try { void navigator.clipboard?.writeText(it.path); } catch { /* clipboard blocked */ }
    toast("Path copied.", "ok");
  };

  const runCleanup = async (scope: "all" | "clean", unmerged: string[]) => {
    setPreview(null);
    const a = await request(
      { action: "clean_up", include_output: scope === "all", unmerged_paths: scope === "all" ? unmerged : [] },
      "cleanup",
    );
    const res = a?.status === "done" ? (a.result as { removed?: unknown[]; kept?: unknown[]; freed_bytes?: number } | null) : null;
    if (res) {
      const msg = `Removed ${res.removed?.length ?? 0} worktree${(res.removed?.length ?? 0) === 1 ? "" : "s"} · ${formatSize(res.freed_bytes ?? 0)} freed`
        + ((res.kept?.length ?? 0) ? ` · ${res.kept?.length} kept` : "");
      setReport(msg);
      toast(msg + ".", "ok");
    }
  };

  if (!cid || unsupported) return null;
  const settings = data?.settings;
  const inv = data?.inventory;
  const cleanCount = items.filter((i) => i.state === "clean").length;
  const graceN = Number(grace);
  const graceValid = grace.trim() !== "" && Number.isInteger(graceN) && graceN >= 0 && graceN <= 90;
  const graceDirty = !!settings && graceValid && graceN !== settings.grace_days;
  const lockTip = (el: ReactElement) => (locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{el}</Tooltip> : el);

  return (
    <SettingsGroup
      settab="execution" title="Agent worktrees" flush
      help="Agents work in their own git worktrees under .orcha-worktrees. Clean ones are removed automatically; output is attached to its task (or kept in .orcha/saved-output) before a worktree with output is removed; unmerged commits are never removed automatically."
      action={inv ? (
        <Button size="sm" variant="ghost" id="wtgRefresh" disabled={locked || !!busy} busy={busy === "refresh"}
          onClick={() => void request({ action: "refresh" }, "refresh")}>Refresh</Button>
      ) : null}
    >
      {loadErr ? <StatusLine tone="err">Couldn't load agent worktrees — {loadErr}.</StatusLine> : null}
      <SettingRows id="wtgSettings">
        <SettingRow label="Clean up agent worktrees automatically" id="wtgAutoL"
          desc={<span id="wtgAutoD">Removes clean worktrees after each run and in an hourly sweep. Worktrees with output are kept for the grace period after their task ends.</span>}>
          {lockTip(
            <button type="button" id="wtgAuto" role="switch"
              className={"set-switch" + (settings?.auto_cleanup ? " on" : "") + (locked ? " is-locked" : "")}
              aria-checked={!!settings?.auto_cleanup} aria-labelledby="wtgAutoL" aria-describedby="wtgAutoD"
              aria-disabled={locked || undefined} disabled={!settings || busy === "settings"}
              onClick={() => { if (!locked && settings) void saveSettings({ auto_cleanup: !settings.auto_cleanup }); }}>
              <span className="set-switch-knob" />
            </button>,
          )}
        </SettingRow>
        <SettingRow label="Grace period" id="wtgGraceL"
          desc={<span id="wtgGraceD">Days a worktree with output is kept after its task is completed or cancelled{!graceValid ? " · Enter a whole number from 0 to 90." : ""}.</span>}>
          {lockTip(
            <div className="set-agent-limit">
              <input id="wtgGrace" className="set-agent-limit-n" type="number" min={0} max={90} step={1} value={grace}
                aria-labelledby="wtgGraceL" aria-describedby="wtgGraceD" aria-invalid={!graceValid || undefined}
                disabled={locked || !settings || busy === "settings"}
                onChange={(e) => setGrace(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && graceDirty) void saveSettings({ grace_days: graceN }); }} />
              <span className="set-val">days</span>
              {graceDirty && !locked ? <Button size="sm" variant="primary" onClick={() => void saveSettings({ grace_days: graceN })}>Save</Button> : null}
            </div>,
          )}
        </SettingRow>
      </SettingRows>

      {!inv ? (
        <StatusLine tone="muted">
          No inventory yet — the notifier reports this project's worktrees within a few minutes of starting.
          {" "}<Button size="sm" variant="ghost" disabled={locked || !!busy} busy={busy === "refresh"} onClick={() => void request({ action: "refresh" }, "refresh")}>Ask now</Button>
        </StatusLine>
      ) : (
        <>
          <div className="wtg-summary" id="wtgSummary">
            <span><b>{items.length}</b> worktree{items.length === 1 ? "" : "s"} · {formatSize(inv.total_bytes)}</span>
            <span><b>{formatSize(inv.reclaimable_bytes)}</b> reclaimable</span>
            <span className="wtg-muted">scanned {relTime(inv.scanned_at)}{inv.host ? " on " + inv.host : ""}</span>
            <span className="wtg-acts">
              {lockTip(<Button size="sm" variant="secondary" id="wtgCleanNow" disabled={locked || !!busy || cleanCount === 0}
                busy={busy === "cleanup" && preview === null} onClick={() => setPreview("clean")}>Clean up now{cleanCount ? ` (${cleanCount})` : ""}</Button>)}
              {lockTip(<Button size="sm" variant="primary" id="wtgCleanAll" disabled={locked || !!busy || items.length === 0}
                onClick={() => setPreview("all")}>Clean up existing worktrees…</Button>)}
            </span>
          </div>
          {report ? <StatusLine tone="ok">{report}</StatusLine> : null}
          {items.length === 0 ? (
            <StatusLine tone="muted">No agent worktrees — nothing to clean up.</StatusLine>
          ) : (
            <ul className="wtg-list" aria-label="Agent worktrees">
              {items.map((it) => (
                <li key={it.path} className="wtg-row" data-state={it.state}>
                  <div className="wtg-row-main">
                    <div className="wtg-row-title">
                      <span>{it.agent || (it.state === "not-quorate" ? "Not an agent worktree" : "—")}</span>
                      <span className="wtg-muted" title={it.task_title || undefined}>{taskLabel(it)}</span>
                    </div>
                    <code className="wtg-branch" title={it.path}>{it.branch || it.name}</code>
                  </div>
                  <span className="wtg-state">
                    <Tooltip label={it.reason || STATE_META[it.state].label} placement="top">
                      <Chip size="sm" dot={STATE_META[it.state].tone}>{STATE_META[it.state].label}</Chip>
                    </Tooltip>
                  </span>
                  <span className="wtg-num wtg-size">{formatSize(it.size_bytes)}</span>
                  <span className="wtg-num wtg-age" title="Last used">{ageLabel(it)}</span>
                  <span className="wtg-row-acts">
                    <Button size="sm" variant="ghost" aria-label={(getHost()?.capabilities.includes("revealPath") ? "Open folder " : "Copy path of ") + it.name} onClick={() => reveal(it)}>
                      {getHost()?.capabilities.includes("revealPath") ? "Open" : "Copy path"}
                    </Button>
                    {it.state === "has-output" ? lockTip(
                      <Button size="sm" variant="ghost" aria-label="Save output to task" disabled={locked || !!busy} busy={busy === "save:" + it.path}
                        onClick={() => void request({ action: "save_output", path: it.path }, "save:" + it.path).then((a) => {
                          if (a?.status === "done") toast("Output saved" + (it.task_title ? " to the task" : "") + ".", "ok");
                        })}>Save output</Button>,
                    ) : null}
                    {it.state !== "in-use" && it.state !== "not-quorate" ? lockTip(
                      <Button size="sm" variant="ghost" disabled={locked || !!busy} busy={busy === "remove:" + it.path}
                        onClick={() => setRemoving(it)}>Remove</Button>,
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {removing ? (
        <RemoveDialog item={removing} onClose={() => setRemoving(null)}
          onConfirm={(keepBranch, confirmBranch) => {
            const it = removing;
            setRemoving(null);
            void request({ action: "remove", path: it.path, keep_branch: keepBranch, confirm_branch: confirmBranch }, "remove:" + it.path)
              .then((a) => { if (a?.status === "done") toast(`Removed ${it.name}.`, "ok"); });
          }} />
      ) : null}
      {preview ? (
        <CleanupPreview items={preview === "clean" ? items.filter((i) => i.state === "clean") : items} scope={preview}
          onClose={() => setPreview(null)} onConfirm={(unmerged) => void runCleanup(preview, unmerged)} />
      ) : null}
    </SettingsGroup>
  );
}

function RemoveDialog({ item, onClose, onConfirm }: {
  item: WorktreeItem; onClose: () => void; onConfirm: (keepBranch: boolean, confirmBranch?: string) => void;
}) {
  const unmerged = item.state === "unmerged";
  const [typed, setTyped] = useState("");
  const [keepBranch, setKeepBranch] = useState(unmerged);
  const files = filesToSave(item);
  const ok = !unmerged || typed.trim() === (item.branch || "");
  return (
    <ConfirmDialog
      title={`Remove ${item.name}?`}
      danger={unmerged}
      confirmLabel={unmerged ? "Remove worktree" : "Remove"}
      description={unmerged
        ? `Its branch ${item.branch} has ${item.unmerged_commits ?? "some"} commit${item.unmerged_commits === 1 ? " that isn't" : "s that aren't"} on the base branch.`
        : item.state === "has-output"
          ? `Its output is saved first — attached to ${item.task_title ? "the task" : "nothing (no task), so copied to .orcha/saved-output"} — then the worktree is removed.`
          : "Only Embodent scaffolding is in it. The worktree and its branch are removed."}
      onClose={onClose}
      onConfirm={() => { if (ok) onConfirm(keepBranch, unmerged ? typed.trim() : undefined); }}
    >
      {files.length ? (
        <div className="wtg-files">
          <div className="wtg-muted">Saves {files.length} file{files.length === 1 ? "" : "s"}:</div>
          <ul>{files.slice(0, 8).map((f) => <li key={f}><code>{f}</code></li>)}{files.length > 8 ? <li>…and {files.length - 8} more</li> : null}</ul>
        </div>
      ) : null}
      {unmerged ? (
        <>
          <label className="wtg-check">
            <input type="checkbox" checked={keepBranch} onChange={(e) => setKeepBranch(e.target.checked)} />
            Keep branch (the commits stay; only the folder goes)
          </label>
          <label className="wtg-confirm">
            <span>Type <code>{item.branch}</code> to confirm</span>
            <input aria-label="Branch name" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
          {!ok && typed ? <div className="wtg-muted">That doesn't match the branch name.</div> : null}
        </>
      ) : null}
    </ConfirmDialog>
  );
}

function CleanupPreview({ items, scope, onClose, onConfirm }: {
  items: WorktreeItem[]; scope: "all" | "clean"; onClose: () => void; onConfirm: (unmerged: string[]) => void;
}) {
  const [optIn, setOptIn] = useState<Set<string>>(new Set());
  const plan = cleanupPlan(items, optIn);
  const groups: Array<{ key: string; title: string; verb: string; rows: WorktreeItem[] }> = [
    { key: "clean", title: "Clean", verb: "remove", rows: plan.remove },
    { key: "has-output", title: "Has output", verb: "save output to the task, then remove", rows: plan.save },
    { key: "unmerged", title: "Unmerged commits", verb: "keep (tick to remove the worktree, keep the branch)", rows: plan.unmerged },
    { key: "in-use", title: "In use / not Embodent", verb: "skipped", rows: plan.skipped },
  ].filter((g) => g.rows.length);
  const count = plan.remove.length + plan.save.length + plan.optIn.length;
  return (
    <ConfirmDialog
      title={scope === "clean" ? "Clean up clean worktrees?" : "Clean up existing worktrees?"}
      confirmLabel={count ? `Clean up ${count} · free ${formatSize(plan.freed)}` : "Nothing to clean up"}
      description="Here is exactly what will happen. Nothing changes until you confirm."
      onClose={onClose}
      onConfirm={() => { if (count) onConfirm([...optIn]); }}
    >
      <div className="wtg-preview" data-testid="wtg-preview">
        {groups.map((g) => (
          <section key={g.key} className="wtg-pgroup" aria-label={g.title}>
            <div className="wtg-pgroup-h">
              <Chip size="sm" dot={STATE_META[(g.key === "in-use" ? "in-use" : g.key) as WorktreeState].tone}>{g.title}</Chip>
              <span className="wtg-muted">{g.rows.length} · {formatSize(g.rows.reduce((n, r) => n + (r.size_bytes || 0), 0))} · {g.verb}</span>
            </div>
            <ul>
              {g.rows.map((r) => (
                <li key={r.path}>
                  {g.key === "unmerged" ? (
                    <label className="wtg-check">
                      <input type="checkbox" checked={optIn.has(r.path)} aria-label={"Remove " + r.name + ", keep branch"}
                        onChange={(e) => setOptIn((s) => { const n = new Set(s); if (e.target.checked) n.add(r.path); else n.delete(r.path); return n; })} />
                      <code>{r.branch}</code> <span className="wtg-muted">{formatSize(r.size_bytes)}</span>
                    </label>
                  ) : (
                    <><code>{r.branch || r.name}</code> <span className="wtg-muted">{formatSize(r.size_bytes)}</span></>
                  )}
                  {g.key === "has-output" ? (
                    <ul className="wtg-savefiles">
                      {filesToSave(r).slice(0, 5).map((f) => <li key={f}><code>{f}</code></li>)}
                      {filesToSave(r).length > 5 ? <li className="wtg-muted">…and {filesToSave(r).length - 5} more</li> : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ConfirmDialog>
  );
}
