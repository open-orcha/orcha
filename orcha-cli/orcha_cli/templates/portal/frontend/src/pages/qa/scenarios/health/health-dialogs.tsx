import { useState } from "react";
import { Button } from "../../map/kit";
import { Dialog } from "../../map/kit";
import { Input } from "../../map/kit";
import { Select } from "../../map/kit";
import { suggestedName } from "./board-model";

export interface ScenarioChoice {
  id: string;
  name: string;
  target_kind: string | null;
  status: string;
}

/** Rename: starts from a plain name for an agent task ("Questions board"), editable. */
export function RenameDialog({
  scenario,
  onClose,
  onSubmit,
}: {
  scenario: { id: string; name: string } | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<string | null>;
}) {
  return scenario ? <RenameForm key={scenario.id} scenario={scenario} onClose={onClose} onSubmit={onSubmit} /> : null;
}

function RenameForm({ scenario, onClose, onSubmit }: { scenario: { id: string; name: string }; onClose: () => void; onSubmit: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(() => suggestedName(scenario.name));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const err = await onSubmit(name.trim());
    setBusy(false);
    if (err) setError(err);
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename scenario"
      description="Name what a user does or sees, not the task that produced it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || name.trim() === scenario.name} onClick={() => void save()} data-health-rename-save>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-2"
      >
        <p className="truncate text-sm text-muted" title={scenario.name}>
          Now: {scenario.name}
        </p>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="New name" aria-invalid={error ? true : undefined} data-health-rename-input />
        {error ? <p className="select-text text-sm text-danger">{error}</p> : null}
      </form>
    </Dialog>
  );
}

/** Merge into…: the duplicate's criteria join the chosen scenario; the duplicate is retired, replaced by it. */
export function MergeDialog({
  source,
  defaultInto,
  choices,
  onClose,
  onSubmit,
}: {
  source: { id: string; name: string; target_kind: string | null } | null;
  defaultInto: string | null;
  choices: readonly ScenarioChoice[];
  onClose: () => void;
  onSubmit: (into: string) => Promise<string | null>;
}) {
  return source ? <MergeForm key={source.id} source={source} defaultInto={defaultInto} choices={choices} onClose={onClose} onSubmit={onSubmit} /> : null;
}

function MergeForm({
  source,
  defaultInto,
  choices,
  onClose,
  onSubmit,
}: {
  source: { id: string; name: string; target_kind: string | null };
  defaultInto: string | null;
  choices: readonly ScenarioChoice[];
  onClose: () => void;
  onSubmit: (into: string) => Promise<string | null>;
}) {
  const options = choices.filter((c) => c.id !== source.id && (!c.target_kind || !source.target_kind || c.target_kind === source.target_kind));
  const [into, setInto] = useState(defaultInto && options.some((o) => o.id === defaultInto) ? defaultInto : (options[0]?.id ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const err = await onSubmit(into);
    setBusy(false);
    if (err) setError(err);
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Merge into another scenario"
      description="Its criteria join the scenario you pick, anything that depended on it moves over, and it is retired (replaced by it), not deleted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!into} onClick={() => void save()} data-health-merge-save>
            Merge
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="truncate text-sm text-muted" title={source.name}>
          Merging: {source.name}
        </p>
        <Select
          aria-label="Merge into"
          value={into}
          onValueChange={setInto}
          options={options.map((o) => ({ value: o.id, label: o.name, hint: o.status === "draft" ? "draft" : undefined }))}
          placeholder="No scenario to merge into"
          data-health-merge-into
        />
        {error ? <p className="select-text text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
