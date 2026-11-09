import { useMemo, useState } from "react";
import { CheckCheck, FileCode2, Play, Trash2, X } from "../map/kit/icons";
import { Button, Select, useToast } from "../map/kit";
import { errText } from "../parts";
import type { Platform } from "../qaApi";
import type { Scenario } from "./adapt";
import { changeStatus, deleteScenario } from "./api";
import { ConfirmDialog } from "./confirm-dialog";
import { HumanGate, useScenarios } from "./context";
import { scenariosToMarkdown } from "./scenario-markdown";
import { NEEDS_REASON, STATUS_LABEL, type EffectiveStatus } from "./scenario-status";
import { StatusReasonForm, statusOptions, type StatusChangeBody } from "./scenario-status-control";
import { TextDialog } from "./text-dialog";

export interface BulkActionBarProps {
  selected: Scenario[];
  allScenarios: readonly Pick<Scenario, "id" | "name">[];
  onClear: () => void;
  /** Applies a patch to each selected scenario locally once the status is saved. */
  onPatched: (id: string, patch: Partial<Scenario>) => void;
  /** Removes deleted ids from local state. */
  onDeleted: (ids: string[]) => void;
  /** Re-reads the list. */
  onSaved: () => void;
}

/**
 * Floating bar shown over the canvas when 2+ scenarios are selected: Validate, "Change status"
 * (Paused, Quarantined and Retired ask for a reason first), run, export and delete. Only a person decides.
 */
export function BulkActionBar({ selected, allScenarios, onClear, onDeleted, onSaved }: BulkActionBarProps) {
  const { toast } = useToast();
  const { cid, auth, runQa } = useScenarios();
  const [busy, setBusy] = useState<"validate" | "status" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A status that needs a reason, waiting on the form above the bar.
  const [pending, setPending] = useState<Exclude<EffectiveStatus, "draft" | "validated"> | null>(null);
  const [textOpen, setTextOpen] = useState(false);

  const text = useMemo(() => scenariosToMarkdown(selected, allScenarios), [selected, allScenarios]);

  /** Every selected scenario to `body.status` in one request. */
  async function setStatus(body: StatusChangeBody) {
    if (!auth.can) return;
    setBusy(body.status === "validated" ? "validate" : "status");
    try {
      await changeStatus(cid, auth.human?.id ?? null, selected.map((s) => s.id), body);
      setPending(null);
      toast({ title: `${selected.length} marked ${STATUS_LABEL[body.status].toLowerCase()}`, description: body.reason ?? undefined, variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Some updates failed", description: errText(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    setBusy("delete");
    try {
      const actor = auth.human?.id ?? null;
      const results = await Promise.all(selected.map(async (s) => ({ id: s.id, ok: await deleteScenario(s.id, actor).then(() => true, () => false) })));
      const gone = results.filter((r) => r.ok).map((r) => r.id);
      if (gone.length > 0) onDeleted(gone);
      const failures = results.length - gone.length;
      if (failures > 0) toast({ title: "Some deletes failed", description: `${failures} of ${selected.length} scenarios could not be deleted.`, variant: "error" });
      else toast({ title: `Deleted ${gone.length} scenario${gone.length === 1 ? "" : "s"}` });
      onSaved();
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  /** Each selected scenario by id, on the platform they share (a mix: the page's platform). */
  function runSelected() {
    const pins = [...new Set(selected.map((s) => s.target_kind))];
    runQa("check", null, { scenarioIds: selected.map((s) => s.id), platform: pins.length === 1 ? (pins[0] as Platform | null) : null });
  }

  function chooseStatus(status: EffectiveStatus) {
    if (NEEDS_REASON.has(status)) setPending(status as Exclude<EffectiveStatus, "draft" | "validated">);
    else void setStatus({ status });
  }

  return (
    <>
      {pending ? (
        <div className="absolute bottom-16 left-1/2 z-10 w-[360px] max-w-[calc(100%-32px)] -translate-x-1/2 rounded-lg border border-border bg-raised p-1.5 shadow-md" data-bulk-status-form>
          <StatusReasonForm key={pending} status={pending} scenarioId={selected[0]?.id ?? ""} others={allScenarios.filter((s) => !selected.some((x) => x.id === s.id))} busy={busy === "status"} onSubmit={(body) => void setStatus(body)} onCancel={() => setPending(null)} />
        </div>
      ) : null}
      <div data-bulk-action-bar className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 shadow-md">
        <span className="whitespace-nowrap text-sm font-medium text-fg" data-bulk-count>
          {selected.length} selected
        </span>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <HumanGate>
          <Button size="sm" loading={busy === "validate"} disabled={!auth.can} onClick={() => void setStatus({ status: "validated" })} data-bulk-validate>
            <CheckCheck /> Validate
          </Button>
        </HumanGate>
        <HumanGate>
          <Select
            dimension="sm"
            aria-label="Change status"
            value=""
            placeholder="Change status"
            disabled={busy === "status" || !auth.can}
            onChange={(e) => e.target.value && chooseStatus(e.target.value as EffectiveStatus)}
            options={statusOptions()}
            renderValue={() => <span className="text-fg">Change status</span>}
            icon={null}
            menuClassName="min-w-[300px]"
            data-bulk-status
          />
        </HumanGate>
        <HumanGate>
          <Button size="sm" disabled={!auth.can} onClick={runSelected} data-bulk-run>
            <Play /> Run selected
          </Button>
        </HumanGate>
        <Button size="sm" onClick={() => setTextOpen(true)} data-bulk-export>
          <FileCode2 /> Export Markdown
        </Button>
        <HumanGate>
          <Button size="sm" variant="danger" loading={busy === "delete"} disabled={!auth.can} onClick={() => setConfirmDelete(true)} data-bulk-delete>
            <Trash2 /> Delete
          </Button>
        </HumanGate>
        <Button variant="ghost" size="sm" icon aria-label="Clear selection" onClick={onClear}>
          <X />
        </Button>
      </div>
      <ConfirmDialog open={confirmDelete} title={`Delete ${selected.length} scenario${selected.length === 1 ? "" : "s"}?`} description="This removes them and their version history. This cannot be undone." loading={busy === "delete"} onConfirm={() => void removeAll()} onClose={() => setConfirmDelete(false)} />
      <TextDialog open={textOpen} onClose={() => setTextOpen(false)} title={`${selected.length} scenarios as Markdown`} description="Each scenario in turn, ready to copy." text={text} />
    </>
  );
}
