import { useRef, useState } from "react";
import { patchScenario } from "../api";
import { useToast } from "../../map/kit";
import { cn } from "../../map/kit";

/**
 * Inline-editable scenario name: click to edit, Enter/blur to save via
 * `PATCH /api/scenarios/[id]` (spec §3 scope extension), Escape to cancel.
 */
export function ScenarioRename({
  scenarioId,
  name,
  actor,
  onRenamed,
  className,
}: {
  scenarioId: string;
  name: string;
  /** Who renames it: the acting human. Without one the name is plain text. */
  actor: string | null;
  onRenamed?: (name: string) => void;
  className?: string;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function save() {
    const next = value.trim();
    if (!next || next === name) {
      setValue(name);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await patchScenario(scenarioId, { name: next }, actor);
      onRenamed?.(next);
      setEditing(false);
    } catch (err) {
      setValue(name);
      toast({
        title: "Could not rename scenario",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  if (!actor) return <span className={cn("min-w-0 truncate px-1.5 py-0.5 text-base font-semibold text-fg", className)}>{name}</span>;

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        disabled={saving}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
        data-scenario-rename-input
        className={cn(
          "min-w-0 rounded-md border border-accent bg-panel px-1.5 py-0.5 text-base font-semibold text-fg outline-none",
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename"
      data-scenario-rename
      className={cn(
        "min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-base font-semibold text-fg transition-colors hover:bg-hover",
        className,
      )}
    >
      {name}
    </button>
  );
}
