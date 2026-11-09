import { useState } from "react";
import { Check, Pencil, X } from "../../map/kit/icons";
import { Button, useToast } from "../../map/kit";
import { keepSession } from "../api";
import { RECIPE_ICON, recipeLabel } from "../recipe-meta";
import { PLATFORM_LABELS, PlatformIcon } from "../../map/kit";
import { WorkFact, WorkFacts } from "../work/work-live";
import type { Exploration, TargetKind } from "../explorations";
import { errText, TaskLink } from "../../parts";
import { viewportWord, type QaSession } from "../../qaApi";
import { lensLabel } from "./model";
import { useSnapshot } from "../../../../state/SnapshotProvider";
import { ProvenanceLinks, useProvenance } from "../../requests/RequestSource";

/** The name, editable in place: Enter saves, Escape cancels. */
export function EditableName({ id, name, actor, canRename, onRenamed }: { id: string; name: string; actor: string | null; canRename: boolean; onRenamed: (name: string) => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    setBusy(true);
    try {
      await keepSession(id, actor, { name: next });
    } catch (err) {
      setBusy(false);
      toast({ title: "Could not rename it", description: errText(err), variant: "error" });
      return;
    }
    setBusy(false);
    onRenamed(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <input
          autoFocus
          value={draft}
          maxLength={120}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Escape") {
              setEditing(false);
              setDraft(name);
            }
          }}
          aria-label="Exploration name"
          className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-control px-2 text-lg font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-name-input
        />
        <Button type="submit" size="md" icon aria-label="Save name" loading={busy}>
          <Check />
        </Button>
        <Button
          type="button"
          size="md"
          variant="ghost"
          icon
          aria-label="Cancel renaming"
          onClick={() => {
            setEditing(false);
            setDraft(name);
          }}
        >
          <X />
        </Button>
      </form>
    );
  }
  return (
    <div className="group flex min-w-0 items-center gap-1.5">
      <h1 className="min-w-0 break-words text-lg font-semibold leading-7 text-fg" data-exploration-name>
        {name}
      </h1>
      <Button
        size="sm"
        variant="ghost"
        icon
        aria-label="Rename"
        title="Rename"
        disabled={!canRename}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
        data-rename
      >
        <Pencil />
      </Button>
    </div>
  );
}

/** The facts of a session, the row under its title on every face: its job and minutes, the lenses,
 * where it ran, the agent and the task. */
export function ExplorationFacts({ exploration, kind, session, agent }: { exploration: Exploration; kind: TargetKind | null; session: QaSession; agent: string | null }) {
  const { cid } = useSnapshot();
  const source = useProvenance(cid, { requestId: session.request_id, sessionId: session.id, taskId: session.task_id });
  const e = exploration;
  const Icon = RECIPE_ICON[e.recipe ?? "custom"];
  return (
    <WorkFacts>
      <WorkFact label="Job">
        <span data-recipe-meta={e.recipe ?? "custom"} className="inline-flex min-w-0 items-center gap-1">
          <Icon aria-hidden strokeWidth={2} />
          <span className="truncate">{recipeLabel(e.recipe)}</span>
          {e.minutes != null ? <span className="shrink-0 tabular text-muted">· {e.minutes} min</span> : null}
        </span>
      </WorkFact>
      <WorkFact label={e.lenses.length === 1 ? "Lens" : "Lenses"}>{e.lenses.map(lensLabel).join(", ")}</WorkFact>
      {kind ? (
        <WorkFact label="Platform">
          <PlatformIcon kind={kind} />
          {PLATFORM_LABELS[kind] ?? kind}
        </WorkFact>
      ) : null}
      {session.device_name ? <WorkFact label={session.platform === "web" ? "Browser" : "Device"}>{session.platform === "web" ? viewportWord(session.device_name) : session.device_name}</WorkFact> : null}
      {session.app_id ? (
        <WorkFact label={session.platform === "web" ? "Site" : "App"} mono title={session.app_id}>
          {session.app_id}
        </WorkFact>
      ) : null}
      {agent ? <WorkFact label="Agent">{agent}</WorkFact> : null}
      {session.task_id ? (
        <WorkFact label="Task">
          <TaskLink id={session.task_id} title={session.task_title} className="truncate" />
        </WorkFact>
      ) : null}
      {source ? <WorkFact label="Came from"><ProvenanceLinks r={source} /></WorkFact> : null}
    </WorkFacts>
  );
}

/** What the person asked for, under the facts. */
export function ExplorationGoal({ goal }: { goal: string | null }) {
  if (!goal) return null;
  return (
    <p className="max-w-prose text-sm text-fg-2" data-detail-goal>
      <span className="text-muted">Asked: </span>
      {goal}
    </p>
  );
}
