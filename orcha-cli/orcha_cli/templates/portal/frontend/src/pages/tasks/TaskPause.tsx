/**
 * GH #343: Pause / Resume for one task, through POST /api/tasks/{id}/pause|resume.
 * People can still read and comment on a paused task; only automatic agent work stops.
 */
import { useState } from "react";

import { Button } from "../../components/primitives";
import { useToast } from "../../components/ui";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Task } from "../../types";
import { isTaskPaused } from "./taskPauseBadge";

export { TaskPausedChip } from "./taskPauseBadge";

/** Pause / Resume button for an open task. Hidden on finished and root tasks. */
export function TaskPauseControl({ t }: { t: Task }) {
  // Same authority as every task action (useActor / useNoHumanReason in TaskDetail),
  // read directly so this control does not import the whole task page.
  const authority = useActingAuthority();
  const actor = authority.human;
  const noHuman = (authority.readOnly || authority.pending) && authority.reason
    ? authority.reason
    : "Pick an acting human first — actions are recorded under a human identity.";
  const toast = useToast();
  const { refresh } = useSnapshot();
  const [busy, setBusy] = useState(false);
  if (t.is_root || t.status === "completed" || t.status === "cancelled") return null;
  const paused = isTaskPaused(t);
  const act = async () => {
    if (!actor) {
      toast(noHuman, "danger");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/tasks/" + encodeURIComponent(t.id) + (paused ? "/resume" : "/pause"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_agent_id: actor.id }),
      });
      if (!r.ok) {
        toast((paused ? "Resume" : "Pause") + " failed (" + r.status + ").", "danger");
        return;
      }
      const d = (await r.json().catch(() => ({}))) as { stopped_runs?: string[] };
      if (paused) {
        toast("Resumed. The assigned agent picks it back up.", "ok");
      } else {
        const stopped = (d.stopped_runs || []).length;
        toast(stopped ? "Paused. The running agent was asked to stop and save its work." : "Paused. No agent will start this task until it's resumed.", "ok");
      }
      void refresh();
    } catch (e) {
      toast((paused ? "Resume" : "Pause") + " failed (" + (e instanceof Error ? e.message : String(e)) + ").", "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy || !actor}
      title={!actor ? noHuman : paused ? "Let agents work on this task again" : "Stop agents from starting or continuing this task"}
      onClick={() => void act()}
      data-task-pause={paused ? "resume" : "pause"}
    >
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}
