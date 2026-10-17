/**
 * Routines — recurring scheduled work (project tab "Routines", route /routines; the
 * integrator mounts it). Idea adapted from Paperclip's routines (MIT).
 *
 * Linear list: one 40px row per routine — clock glyph, title, plain-English schedule,
 * last-result chip, next run, assignee, enabled switch. Selecting a row opens the
 * inspector: schedule, template, Run now / Edit / Delete, and run history (each run's
 * created task and its CURRENT status, or why it was skipped/failed).
 *
 * Truthfulness: the scheduler rides the notifier daemon. When it has never checked in,
 * or hasn't recently, the page says so instead of implying "next run in 2h" will happen.
 * Authority: owner or `manage_agents`; everyone else reads (the server enforces).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Avatar, Button, Chip, ConfirmDialog, EmptyState, IconButton, Inspector, Skeleton, SplitPane, StatusIcon, Tooltip,
} from "../../components/primitives";
import { Icon, useToast } from "../../components/ui";
import { useNarrow } from "../../hooks/useMediaQuery";
import { relTime } from "../../lib/format";
import { Shell } from "../../shell/Shell";
import { CircleIconButton, FilterPills, PageToolbar } from "../../shell/PageChrome";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { RoutineDialog } from "./RoutineDialog";
import { RoutineOrigin } from "./MakeRecurring";
import {
  createRoutine, deleteRoutine, hasTemplateTokens, listRoutines, listRuns, routineTitle, runRoutineNow, updateRoutine,
  type Routine, type RoutineInput, type RoutineLastRun, type RoutineRun,
} from "./routinesApi";
import { formatInZone, relFuture } from "./schedule";
import { routineAuthority } from "./authority";
import "./routines.css";

const REFRESH_MS = 30_000;
/** The notifier pokes the scheduler every ~30 s; beyond this it is not running. */
export const SCHEDULER_STALE_MS = 5 * 60_000;

type Filter = "all" | "active" | "paused";

function errText(e: unknown): string {
  const x = e as { detail?: string; message?: string };
  return x?.detail || x?.message || "Something went wrong";
}

/** The last-result chip: the created task's CURRENT status, or why the run didn't create one. */
export function LastResult({ run }: { run: RoutineLastRun | RoutineRun | null }) {
  if (!run) return <span className="rt-muted">Never run</span>;
  if (run.outcome === "created" && run.task_id) {
    const st = run.task_status || "unknown";
    return (
      <Chip size="sm" to={"/tasks?task=" + encodeURIComponent(run.task_id)} icon={<StatusIcon status={st} size={12} decorative />}
        title={(run.task_title || "Task") + " — open task"}>
        {statusWord(st)}
      </Chip>
    );
  }
  if (run.outcome === "created") return <Chip size="sm" dot="neutral" title="The task was since removed">Task removed</Chip>;
  if (run.outcome === "skipped") return <Chip size="sm" dot="neutral" title={run.detail || undefined}>Skipped</Chip>;
  if (run.outcome === "failed") return <Chip size="sm" dot="danger" title={run.detail || undefined}>Failed</Chip>;
  return <Chip size="sm" dot="info">Creating…</Chip>;
}

function statusWord(s: string): string {
  const map: Record<string, string> = {
    ready: "Ready", pending: "Waiting on deps", in_progress: "In progress", blocked: "Blocked", not_ready: "Held",
    needs_verification: "Needs verification", completed: "Done", cancelled: "Cancelled", failed: "Failed",
  };
  return map[s] || s.replace(/_/g, " ");
}

function triggerWord(r: RoutineRun): string {
  if (r.trigger === "manual") return r.actor_alias ? `Run now by ${r.actor_alias}` : "Run now";
  if (r.trigger === "catch_up") return r.missed_count > 1 ? `Catch-up (${r.missed_count} missed)` : "Catch-up (late)";
  return "Scheduled";
}

function Switch({ on, label, disabled, reason, onChange }: { on: boolean; label: string; disabled?: boolean; reason?: string | null; onChange: (v: boolean) => void }) {
  const btn = (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={"rt-switch" + (on ? " is-on" : "")}
      aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onChange(!on); }}>
      <span className="rt-switch-knob" />
    </button>
  );
  return disabled && reason ? <Tooltip label={reason} placement="left">{btn}</Tooltip> : btn;
}

function SchedulerNotice({ lastTick, hasEnabled }: { lastTick: string | null; hasEnabled: boolean }) {
  if (!hasEnabled) return null;
  const age = lastTick ? Date.now() - new Date(lastTick).getTime() : Infinity;
  if (age < SCHEDULER_STALE_MS) return null;
  return (
    <div className="rt-notice" role="status">
      <Icon name="alert" cls="v2-ico" />
      <span>
        {lastTick
          ? `The scheduler last checked ${relTime(lastTick)} — routines only fire while the Embodent notifier is running. Runs missed meanwhile become one catch-up task when it's back.`
          : "The scheduler hasn't checked in yet — routines fire while the Embodent notifier is running (orcha up starts it)."}
      </span>
    </div>
  );
}

export function RoutinesPage() {
  const { snap, cid, identity } = useSnapshot();
  const acting = useActingAuthority();
  const auth = routineAuthority(acting, identity);
  const toast = useToast();
  const narrow = useNarrow();
  const agents = useMemo(() => snap?.agents ?? [], [snap]);

  const [data, setData] = useState<{ cid: string; routines: Routine[]; lastTick: string | null } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  // a task's "Recurring" link lands here as /routines?routine=<id> — preselect it
  const [params] = useSearchParams();
  const [selId, setSelId] = useState<string | null>(() => params.get("routine"));
  const [dialog, setDialog] = useState<{ routine: Routine | null } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "run" | "delete"; routine: Routine } | null>(null);
  const [actBusy, setActBusy] = useState(false);
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!cid) return;
    const ctl = new AbortController();
    listRoutines(cid, ctl.signal).then(
      (d) => { setData({ cid, routines: d.routines, lastTick: d.scheduler.last_tick_at }); setLoadErr(null); },
      (e) => { if (!ctl.signal.aborted) setLoadErr(errText(e)); },
    );
    const t = setInterval(refresh, REFRESH_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [cid, nonce, refresh]);

  const routines = data && data.cid === cid ? data.routines : null;
  const counts = useMemo(() => ({
    all: routines?.length ?? 0,
    active: routines?.filter((r) => r.enabled).length ?? 0,
    paused: routines?.filter((r) => !r.enabled).length ?? 0,
  }), [routines]);
  const shown = (routines ?? []).filter((r) => filter === "all" || (filter === "active" ? r.enabled : !r.enabled));
  const selected = routines?.find((r) => r.id === selId) ?? null;

  const replace = (r: Routine) => setData((d) => (d ? { ...d, routines: d.routines.map((x) => (x.id === r.id ? r : x)) } : d));

  const submitDialog = async (body: RoutineInput) => {
    if (!cid || !dialog) return;
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const actor = auth.human?.id ?? null;
      const saved = dialog.routine ? await updateRoutine(dialog.routine.id, actor, body) : await createRoutine(cid, actor, body);
      if (dialog.routine) replace(saved);
      else setData((d) => (d ? { ...d, routines: [...d.routines, saved] } : d));
      setSelId(saved.id);
      setDialog(null);
      toast(dialog.routine ? "Routine saved." : "Routine created.", "ok");
      refresh();
    } catch (e) {
      setDialogErr(errText(e));
    } finally {
      setDialogBusy(false);
    }
  };

  const toggle = async (r: Routine, on: boolean) => {
    if (!auth.can) return;
    setToggling((t) => ({ ...t, [r.id]: true }));
    replace({ ...r, enabled: on });
    try {
      replace(await updateRoutine(r.id, auth.human?.id ?? null, { enabled: on }));
    } catch (e) {
      replace(r);
      toast("Couldn't " + (on ? "enable" : "pause") + " the routine — " + errText(e), "danger");
    } finally {
      setToggling((t) => ({ ...t, [r.id]: false }));
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    setActBusy(true);
    const { kind, routine } = confirm;
    try {
      if (kind === "run") {
        const res = await runRoutineNow(routine.id, auth.human?.id ?? null);
        toast(res.detail ? "Task created — " + res.detail : "Task created.", "ok");
      } else {
        await deleteRoutine(routine.id, auth.human?.id ?? null);
        setData((d) => (d ? { ...d, routines: d.routines.filter((x) => x.id !== routine.id) } : d));
        setSelId(null);
        toast("Routine deleted. Its history and tasks are kept.", "ok");
      }
      setConfirm(null);
      refresh();
    } catch (e) {
      toast((kind === "run" ? "Couldn't run the routine — " : "Couldn't delete the routine — ") + errText(e), "danger", { sticky: true });
      setConfirm(null);
      refresh();
    } finally {
      setActBusy(false);
    }
  };

  const newBtn = (
    <Tooltip label={auth.reason || "New routine"} placement="bottom" disabled={auth.can}>
      <Button variant="primary" size="sm" icon="plus" disabled={!auth.can} onClick={() => { setDialogErr(null); setDialog({ routine: null }); }}>
        New routine
      </Button>
    </Tooltip>
  );

  const toolbar = (
    <PageToolbar label="Routine filters" end={<CircleIconButton icon="refresh" label="Refresh" onClick={refresh} />}>
      <FilterPills label="Show" value={filter} onChange={(k) => setFilter(k as Filter)}
        items={[
          { key: "all", label: "All", count: counts.all },
          { key: "active", label: "Active", count: counts.active },
          { key: "paused", label: "Paused", count: counts.paused },
        ]} />
    </PageToolbar>
  );

  const list = (
    <div className="rt-listwrap">
      <SchedulerNotice lastTick={data?.lastTick ?? null} hasEnabled={counts.active > 0} />
      {loadErr && !routines ? (
        <EmptyState tone="danger" title="Couldn't load routines" body={loadErr} action={<Button size="sm" onClick={refresh}>Retry</Button>} />
      ) : !routines ? (
        <Skeleton lines={4} label="Loading routines" />
      ) : routines.length === 0 ? (
        <EmptyState icon="clock" title="No routines yet"
          body="A routine creates a normal task on a schedule — a weekly dependency audit, a daily triage. Every task still goes through plan approval and verification."
          action={auth.can ? newBtn : <span className="rt-muted">{auth.reason}</span>} />
      ) : shown.length === 0 ? (
        <EmptyState compact title={filter === "active" ? "No active routines" : "No paused routines"} />
      ) : (
        <ul className="rt-list" aria-label="Routines">
          {shown.map((r) => (
            <li key={r.id} className={"rt-row" + (r.id === selId ? " is-selected" : "") + (r.enabled ? "" : " is-paused")}>
              <button type="button" className="rt-row-main" aria-current={r.id === selId ? "true" : undefined}
                onClick={() => setSelId(r.id === selId ? null : r.id)}>
                <Icon name="clock" cls="v2-ico rt-row-ico" />
                <span className="rt-row-title" title={routineTitle(r) !== r.title ? "Template: " + r.title : undefined}>{routineTitle(r)}</span>
                <span className="rt-row-sched">{r.schedule_text}</span>
              </button>
              <span className="rt-row-last"><LastResult run={r.last_run} /></span>
              <span className="rt-row-next" title={r.next_run_at ? formatInZone(r.next_run_at, r.timezone) : undefined}>
                {r.enabled ? (r.next_run_at ? relFuture(r.next_run_at) : "No upcoming run") : "Paused"}
              </span>
              <span className="rt-row-asg">
                {r.assignee_alias ? <Avatar alias={r.assignee_alias} kind="ai" size={20} /> : <span className="rt-muted" title="Unassigned — normal assignment">—</span>}
              </span>
              <Switch on={r.enabled} label={(r.enabled ? "Pause " : "Enable ") + routineTitle(r)} disabled={!auth.can || toggling[r.id]}
                reason={auth.reason} onChange={(v) => toggle(r, v)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const inspector = selected ? (
    <RoutineInspector key={selected.id} routine={selected} nonce={nonce} can={auth.can} reason={auth.reason}
      onClose={() => setSelId(null)}
      onEdit={() => { setDialogErr(null); setDialog({ routine: selected }); }}
      onRun={() => setConfirm({ kind: "run", routine: selected })}
      onDelete={() => setConfirm({ kind: "delete", routine: selected })} />
  ) : null;

  return (
    <Shell page="routines" title="Routines" ctx={snap?.container?.name ?? undefined} primaryAction={routines && routines.length ? newBtn : undefined} toolbar={toolbar} flush>
      <div className="rt-page">
        {narrow ? (inspector ?? list) : <SplitPane list={list} inspector={inspector} storageKey="orcha:v2:routinesInspector" defaultSize={420} />}
      </div>
      {dialog && cid ? (
        <RoutineDialog cid={cid} routine={dialog.routine} agents={agents} busy={dialogBusy} error={dialogErr}
          onSubmit={submitDialog} onClose={() => setDialog(null)} />
      ) : null}
      {confirm ? (
        confirm.kind === "run" ? (
          <ConfirmDialog title={`Run “${routineTitle({ ...confirm.routine, title_preview: null, next_run_at: null })}” now?`} confirmLabel="Create task" busy={actBusy}
            description={`This creates a normal task now${confirm.routine.assignee_alias ? `, assigned to ${confirm.routine.assignee_alias}` : ""}. Plan approval and verification apply as usual. The schedule isn't changed.`}
            onConfirm={doConfirm} onClose={() => setConfirm(null)} />
        ) : (
          <ConfirmDialog danger title={`Delete “${routineTitle(confirm.routine)}”?`} confirmLabel="Delete routine" busy={actBusy}
            description="It stops creating tasks. Its run history and the tasks it already created are kept."
            onConfirm={doConfirm} onClose={() => setConfirm(null)} />
        )
      ) : null}
    </Shell>
  );
}

function RoutineInspector({ routine: r, nonce, can, reason, onClose, onEdit, onRun, onDelete }: {
  routine: Routine; nonce: number; can: boolean; reason: string | null;
  onClose: () => void; onEdit: () => void; onRun: () => void; onDelete: () => void;
}) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    listRuns(r.id, ctl.signal).then((d) => { setRuns(d.runs); setErr(null); }, (e) => { if (!ctl.signal.aborted) setErr(errText(e)); });
    return () => ctl.abort();
  }, [r.id, nonce, r.last_run?.run_id]);

  const gated = (label: string, icon: string, onClick: () => void, variant: "ghost" | "danger" = "ghost") => (
    <IconButton icon={icon} label={can ? label : `${label} — ${reason ?? "not allowed"}`} size="sm" variant={variant} disabled={!can} onClick={onClick} />
  );

  return (
    <Inspector title={routineTitle(r)} label="Routine details" onClose={onClose}
      meta={<span>{r.schedule_text}{r.enabled ? "" : " · Paused"}</span>}
      actions={<>
        {gated("Edit routine", "pencil", onEdit)}
        {gated("Delete routine", "trash", onDelete, "danger")}
      </>}>
      <div className="rt-insp">
        <div className="rt-insp-actions">
          <Tooltip label={reason || ""} disabled={can} placement="bottom">
            <Button size="sm" icon="play" disabled={!can} onClick={onRun}>Run now</Button>
          </Tooltip>
        </div>
        <dl className="rt-kv">
          <dt>Next run</dt>
          <dd>{r.enabled ? (r.next_run_at ? `${formatInZone(r.next_run_at, r.timezone)} (${relFuture(r.next_run_at)})` : "No upcoming run") : "Paused"}</dd>
          <dt>Timezone</dt><dd>{r.timezone.replace(/_/g, " ")}</dd>
          <dt>Assignee</dt>
          <dd>{r.assignee_alias ? r.assignee_alias + (r.assignee_retired ? " (retired — tasks left unassigned)" : "") : "Unassigned — normal assignment"}</dd>
          <dt>If still open</dt><dd>{r.skip_if_open ? "Skip the run" : "Create another task"}</dd>
          <dt>Tasks created as</dt><dd>{r.updated_by_alias || r.created_by_alias || "—"}</dd>
        </dl>
        <RoutineOrigin routine={{ origin_task_id: r.origin_task_id ?? null, origin_task_title: r.origin_task_title ?? null }} />
        <section className="rt-insp-sec" aria-label="Task template">
          <h3 className="rt-insp-h">Task template</h3>
          {hasTemplateTokens(r.title) ? <p className="rt-pre"><span className="rt-muted">Template: </span>{r.title}</p> : null}
          {r.description ? <p className="rt-pre">{r.description}</p> : null}
          <p className="rt-pre"><span className="rt-muted">Done when: </span>{r.definition_of_done}</p>
        </section>
        <section className="rt-insp-sec" aria-label="Run history">
          <h3 className="rt-insp-h">History</h3>
          {err ? <p className="rt-error">{err}</p> : !runs ? <Skeleton lines={2} label="Loading history" /> : runs.length === 0 ? (
            <p className="rt-muted">No runs yet.</p>
          ) : (
            <ol className="rt-runs">
              {runs.map((run) => (
                <li key={run.run_id} className="rt-run">
                  <div className="rt-run-top">
                    <LastResult run={run} />
                    {run.task_id && run.task_title ? (
                      <Link className="rt-run-task" to={"/tasks?task=" + encodeURIComponent(run.task_id)}>{run.task_title}</Link>
                    ) : null}
                    <span className="rt-run-when" title={new Date(run.created_at).toLocaleString()}>{relTime(run.created_at)}</span>
                  </div>
                  <div className="rt-run-meta">
                    {triggerWord(run)}
                    {run.scheduled_for ? ` · for ${formatInZone(run.scheduled_for, r.timezone)}` : ""}
                    {run.detail ? <span className="rt-run-detail"> · {run.detail}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Inspector>
  );
}

export default RoutinesPage;
