import { useState } from "react";
import { Plus, Trash2, X } from "../map/kit/icons";
import { Button, Input, Select, TagInput, cn, useToast } from "../map/kit";
import { errText } from "../parts";
import { PLATFORMS, type Platform, type QaScenario } from "../qaApi";
import { platformWord } from "../qaWords";
import { proposeScenario } from "./api";
import { fromChecks } from "./adapt";
import { buildChecks } from "./scenario-panel";
import { HumanGate, useScenarios } from "./context";
import { PanelSection, PropRow, textareaClass } from "./panel-ui";

interface Draft {
  name: string;
  category: string;
  description: string;
  criteria: string[];
  /** One text per criterion, a check per line. */
  checks: string[];
  tags: string[];
  platform: Platform;
}

/**
 * The new-scenario editor: one draft beside the Scenarios list, every field editable, nothing
 * created until "Create draft". A scenario needs two criteria at least (a name and an outcome).
 */
export function NewScenarioReview({ platform, onClose, onCreated }: { platform: Platform; onClose: () => void; onCreated: (row: QaScenario) => void }) {
  const { toast } = useToast();
  const { cid, auth } = useScenarios();
  const [d, setD] = useState<Draft>({ name: "New scenario", category: "General", description: "", criteria: ["", ""], checks: ["", ""], tags: [], platform });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  async function save() {
    if (!auth.can) return;
    const criteria = d.criteria.map((c) => c.trim());
    const kept = criteria.flatMap((c, i) => (c ? [i] : []));
    if (!d.name.trim()) return setError("Give it a name.");
    if (kept.length < 2) return setError("State at least two outcomes a user can see.");
    setSaving(true);
    setError(null);
    try {
      const row = await proposeScenario(cid, auth.human?.id ?? null, d.platform, {
        name: d.name.trim(),
        category: d.category.trim() || "General",
        description: d.description.trim() || null,
        criteria: kept.map((i) => criteria[i]),
        checks: fromChecks(buildChecks(kept.map((i) => d.checks[i] ?? ""))),
        tags: d.tags,
      });
      toast({ title: "Draft created", description: `“${row.name}” is in Scenarios as a draft.`, variant: "success" });
      onCreated(row);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside aria-label="New scenario" className="flex min-w-0 shrink-0 flex-col border-l border-border bg-panel max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-full max-md:border-l-0 md:w-[440px]" data-new-scenario-review>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <h2 className="text-sm font-semibold text-fg">New scenario</h2>
        <span className="ml-1 rounded-full bg-success/12 px-1.5 py-px text-[10px] font-medium text-success">Not created yet</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <p className="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/[0.06] px-3 py-2 text-xs text-danger" role="alert" data-new-scenario-error>
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-1 px-4 pb-3 pt-3.5">
          <input
            aria-label="Name"
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            className="-mx-1.5 rounded-md border border-transparent bg-success/[0.06] px-1.5 py-0.5 text-lg font-semibold leading-7 tracking-[-0.01em] text-fg hover:border-border focus-visible:border-accent"
            data-new-scenario-name
          />
          <textarea
            aria-label="Description"
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={4}
            placeholder="What is this scenario verifying?"
            className="-mx-1.5 resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm text-fg-2 hover:border-border focus-visible:border-accent"
          />
        </div>
        <PanelSection title="Details">
          <div className="flex flex-col gap-2">
            <PropRow label="Category">
              <Input value={d.category} onChange={(e) => set({ category: e.target.value })} aria-label="Category" />
            </PropRow>
            <PropRow label="Platform">
              <Select dimension="sm" value={d.platform} onValueChange={(v) => set({ platform: v as Platform })} options={PLATFORMS.map((p) => ({ value: p, label: platformWord(p) }))} aria-label="Platform" />
            </PropRow>
            <PropRow label="Tags">
              <TagInput value={d.tags} onChange={(tags) => set({ tags })} aria-label="Tags" max={20} />
            </PropRow>
          </div>
        </PanelSection>
        <PanelSection
          title="Acceptance criteria"
          action={
            <Button size="sm" variant="ghost" onClick={() => set({ criteria: [...d.criteria, ""], checks: [...d.checks, ""] })}>
              <Plus /> Add
            </Button>
          }
        >
          <ol className="flex flex-col gap-2">
            {d.criteria.map((c, i) => (
              <li key={i} className="flex flex-col gap-1" data-criterion-row={i}>
                <div className="-mx-1.5 flex items-center gap-1.5 rounded-md bg-success/[0.06] px-1.5 py-0.5 ring-1 ring-success/25">
                  <span className="w-4 shrink-0 text-right text-xs tabular text-muted">{i + 1}.</span>
                  <Input value={c} onChange={(e) => set({ criteria: d.criteria.map((x, k) => (k === i ? e.target.value : x)) })} className="flex-1" aria-label={`Criterion ${i + 1}`} />
                  <Button size="sm" variant="ghost" icon aria-label="Remove criterion" disabled={d.criteria.length === 2} onClick={() => set({ criteria: d.criteria.filter((_, k) => k !== i), checks: d.checks.filter((_, k) => k !== i) })}>
                    <Trash2 />
                  </Button>
                </div>
                <textarea
                  aria-label={`Checks for criterion ${i + 1}`}
                  value={d.checks[i] ?? ""}
                  onChange={(e) => set({ checks: d.checks.map((x, k) => (k === i ? e.target.value : x)) })}
                  rows={Math.max(1, (d.checks[i] ?? "").split("\n").length)}
                  placeholder={'Check: text "…" (optional, one per line)'}
                  className={cn(textareaClass, "ml-[22px] w-[calc(100%-22px)] font-mono text-[11px]")}
                />
              </li>
            ))}
          </ol>
        </PanelSection>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
        <HumanGate>
          <Button variant="primary" size="sm" loading={saving} disabled={!auth.can} onClick={() => void save()} data-new-scenario-create>
            Create draft
          </Button>
        </HumanGate>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Discard
        </Button>
      </div>
    </aside>
  );
}
