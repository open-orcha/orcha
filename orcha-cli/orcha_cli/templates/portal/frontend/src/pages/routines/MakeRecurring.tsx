/**
 * "Make recurring…" from a task (task ⋯ menu in the detail header and the task list row).
 *
 * Opens the Routines page's own create form (RoutineDialog) pre-filled as a COPY of the
 * task: title, description, definition of done, assignee (AI agents only — routines
 * assign each run to an AI agent) and priority. The task itself is never converted or
 * changed; the routine only records where it came from (`origin_task_id`, shown as
 * "Created from task #…" on the routine) and the task shows a small "Recurring" link back.
 *
 * Authority mirrors routine creation (owner / manage_agents — routineAuthority); the
 * server enforces it again.
 */
import { useCallback, useEffect, useState } from "react";
import { Chip } from "../../components/primitives";
import type { MenuItemSpec } from "../../components/primitives";
import { Icon, useToast } from "../../components/ui";
import { shortId } from "../../lib/format";
import { agentByAlias, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Snapshot, Task } from "../../types";
import { routineAuthority } from "./authority";
import { RoutineDialog } from "./RoutineDialog";
import { createRoutine, listRoutinesFromTask, type Routine, type RoutineInput } from "./routinesApi";
import "./routines.css";

export const MAKE_RECURRING_LABEL = "Make recurring…";

/** The routine template a task becomes: a copy of its fields (never the task itself). */
export function routinePrefillFromTask(t: Task, snap: Snapshot | null): Partial<RoutineInput> {
  const aliases = (t.assignees || []).length ? t.assignees : t.assignee ? [t.assignee] : [];
  const ai = aliases.map((al) => agentByAlias(snap, al)).find((a) => a && a.kind === "ai");
  // null / "" would read as 0 (= urgent) — an unset priority is the default 100
  const prio = t.priority == null || t.priority === "" ? NaN : Number(t.priority);
  return {
    title: t.title || "",
    description: t.description ? t.description : null,
    definition_of_done: t.definition_of_done || "",
    assignee_agent_id: ai ? String(ai.id) : null,
    priority: Number.isFinite(prio) && prio >= 0 ? Math.round(prio) : 100,
  };
}

/** Can the acting human make a routine from this task? (menu item gate) */
export function useMakeRecurringGate(): { can: boolean; reason: string | null } {
  const { identity } = useSnapshot();
  const auth = routineAuthority(useActingAuthority(), identity);
  return { can: auth.can, reason: auth.reason };
}

/** The ⋯ menu entry: enabled only for routine managers; the reason shows otherwise. */
export function makeRecurringItem(gate: { can: boolean; reason: string | null }, open: () => void, t: Task): MenuItemSpec | null {
  if (t.is_root) return null;
  return gate.can
    ? { label: MAKE_RECURRING_LABEL, icon: "clock", onSelect: open }
    : { label: MAKE_RECURRING_LABEL, icon: "clock", disabled: true, disabledReason: gate.reason || "Not allowed" };
}

export function MakeRecurringDialog({ task, onClose, onCreated }: {
  task: Task;
  onClose: () => void;
  onCreated?: (r: Routine) => void;
}) {
  const { snap, cid, identity } = useSnapshot();
  const auth = routineAuthority(useActingAuthority(), identity);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initial] = useState(() => routinePrefillFromTask(task, snap));
  if (!cid) return null;

  const submit = async (body: RoutineInput) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await createRoutine(cid, auth.human?.id ?? null, { ...body, origin_task_id: task.id });
      toast("Routine created — " + saved.schedule_text + ". The task is unchanged.", "ok");
      onCreated?.(saved);
      notifyRecurringChanged(task.id);
      onClose();
    } catch (e) {
      const x = e as { detail?: string; message?: string };
      setError(x?.detail || x?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoutineDialog cid={cid} routine={null} agents={snap?.agents ?? []} busy={busy} error={error}
      initial={initial} origin={{ taskId: task.id, title: task.title }} heading="Make recurring"
      onSubmit={(b) => void submit(b)} onClose={onClose} />
  );
}

/* ---- the task's "Recurring" link ------------------------------------------ */

const EVT = "orcha:recurring-changed";
function notifyRecurringChanged(taskId: string) {
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: taskId }));
  } catch { /* non-DOM env */ }
}

/** Routines created from this task (null while loading / unavailable). */
export function useTaskRoutines(cid: string | null | undefined, taskId: string): Routine[] | null {
  const [state, setState] = useState<{ key: string; routines: Routine[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  const bump = useCallback((e: Event) => {
    if ((e as CustomEvent).detail === taskId) setNonce((n) => n + 1);
  }, [taskId]);
  useEffect(() => {
    window.addEventListener(EVT, bump);
    return () => window.removeEventListener(EVT, bump);
  }, [bump]);
  useEffect(() => {
    if (!cid) return;
    const ctl = new AbortController();
    const key = cid + ":" + taskId;
    listRoutinesFromTask(cid, taskId, ctl.signal).then(
      (d) => setState({ key, routines: d.routines }),
      () => { if (!ctl.signal.aborted) setState({ key, routines: [] }); },
    );
    return () => ctl.abort();
  }, [cid, taskId, nonce]);
  return state && state.key === (cid ?? "") + ":" + taskId ? state.routines : null;
}

/** Small "Recurring" chip(s) linking to the routine(s) made from this task; nothing when none. */
export function RecurringLink({ routines }: { routines: Routine[] | null }) {
  if (!routines || !routines.length) return null;
  const [first] = routines;
  return (
    <span className="rt-recurring">
      <Chip size="sm" to={"/routines?routine=" + encodeURIComponent(first.id)} icon={<Icon name="clock" cls="v2-ico" />}
        title={"Recurring: " + first.schedule_text + (first.enabled ? "" : " (paused)") + " — open routine"}>
        {first.enabled ? "Recurring" : "Recurring · paused"}
      </Chip>
      {routines.length > 1 ? <span className="v2-muted" title={routines.length + " routines were made from this task"}>+{routines.length - 1}</span> : null}
    </span>
  );
}

/** "Created from task #abcd1234" on a routine (links to the task; muted when it's gone). */
export function RoutineOrigin({ routine }: { routine: Pick<Routine, "origin_task_id" | "origin_task_title"> }) {
  if (!routine.origin_task_id) return null;
  const id = shortId(routine.origin_task_id);
  return (
    <p className="rt-origin">
      <Icon name="link" cls="v2-ico" />
      <span>Created from task</span>
      <Chip size="sm" to={"/tasks?task=" + encodeURIComponent(routine.origin_task_id)}
        title={(routine.origin_task_title || "Task") + " — open task"}>
        <span className="tnum">#{id}</span>{routine.origin_task_title ? " " + routine.origin_task_title : ""}
      </Chip>
    </p>
  );
}
