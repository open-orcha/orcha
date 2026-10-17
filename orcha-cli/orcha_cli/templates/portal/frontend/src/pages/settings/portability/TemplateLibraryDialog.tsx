/**
 * The project's template library: definition-of-done presets and skills (mig 059) — the
 * two template sections that live nowhere else. List / add / edit / delete (archive).
 * Reads are for every member; writes need owner or manage_agents (the server enforces;
 * without it the list is read-only and says why).
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Button, Chip, Dialog, IconButton, Segmented } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import { settingsErrText, StatusLine } from "../settingsUi";
import {
  createLibraryItem, deleteLibraryItem, listLibrary, updateLibraryItem,
  type LibraryItem, type LibraryKind,
} from "./portabilityApi";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface TemplateLibraryDialogProps {
  cid: string;
  actor: string | null;
  /** why the actor can't edit (null when they can) */
  readOnlyReason: string | null;
  initialKind?: LibraryKind;
  onClose: () => void;
  onChanged?: () => void;
}

interface Draft { id: string | null; name: string; description: string; body: string }
const EMPTY: Draft = { id: null, name: "", description: "", body: "" };

/** Client-side check mirroring the server's rules (pure, tested). */
export function draftError(kind: LibraryKind, d: Draft): string | null {
  if (!d.name.trim()) return "Give it a name.";
  if (kind === "skills" && !SKILL_NAME.test(d.name.trim())) return "Skill names use lowercase letters, digits and dashes — e.g. release-checklist.";
  if (!d.body.trim()) return kind === "skills" ? "Write the skill's instructions." : "Write the definition of done.";
  return null;
}

export function TemplateLibraryDialog({ cid, actor, readOnlyReason, initialKind = "dod-presets", onClose, onChanged }: TemplateLibraryDialogProps) {
  const ids = { name: useId(), desc: useId(), body: useId() };
  const [kind, setKind] = useState<LibraryKind>(initialKind);
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = !readOnlyReason;

  const load = useCallback(() => {
    setItems(null);
    listLibrary(cid, kind).then(
      (r) => { setItems(r.items); setLoadError(null); },
      (e) => { setItems([]); setLoadError(settingsErrText(e)); },
    );
  }, [cid, kind]);
  useEffect(() => { load(); setDraft(null); setError(null); }, [load]);

  const save = async () => {
    if (!draft) return;
    const bad = draftError(kind, draft);
    if (bad) { setError(bad); return; }
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { actor_agent_id: actor, name: draft.name.trim(), body: draft.body };
    if (kind === "skills") body.description = draft.description.trim() || null;
    try {
      if (draft.id) await updateLibraryItem(kind, draft.id, body);
      else await createLibraryItem(cid, kind, body);
      setDraft(null);
      load();
      onChanged?.();
    } catch (e) {
      setError("Couldn't save — " + settingsErrText(e) + ".");
    }
    setBusy(false);
  };

  const remove = async (it: LibraryItem) => {
    setBusy(true);
    setError(null);
    try {
      await deleteLibraryItem(kind, it.id, actor);
      load();
      onChanged?.();
    } catch (e) {
      setError("Couldn't delete — " + settingsErrText(e) + ".");
    }
    setBusy(false);
  };

  const noun = kind === "skills" ? "skill" : "preset";
  return (
    <Dialog
      title="Template library"
      description="Reusable pieces this project keeps and carries in its templates."
      onClose={onClose}
      size="md"
      className="pt-dialog pt-lib"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="pt-body">
        <div className="pt-libbar">
          <Segmented
            size="sm"
            label="Library section"
            value={kind}
            onChange={(k) => setKind(k as LibraryKind)}
            items={[{ key: "dod-presets", label: "DoD presets" }, { key: "skills", label: "Skills" }]}
          />
          {canEdit && !draft ? (
            <Button size="sm" variant="secondary" icon="plus" onClick={() => { setDraft(EMPTY); setError(null); }}>New {noun}</Button>
          ) : null}
        </div>
        <p className="pt-hint">
          {kind === "skills"
            ? "Named playbooks for your agents. Stored with the project and exported in templates — agents don't load them automatically yet."
            : "Definition-of-done texts to reuse when writing tasks and routines."}
        </p>
        {!canEdit && readOnlyReason ? <StatusLine tone="muted" icon="shield">{readOnlyReason}</StatusLine> : null}
        {loadError ? <StatusLine tone="err">Couldn't load — {loadError}.</StatusLine> : null}

        {draft ? (
          <div className="pt-form" aria-label={draft.id ? `Edit ${noun}` : `New ${noun}`} role="group">
            <label className="pt-field" htmlFor={ids.name}>
              <span className="pt-label">Name</span>
              <input id={ids.name} className="pt-input" value={draft.name} maxLength={kind === "skills" ? 63 : 120}
                placeholder={kind === "skills" ? "release-checklist" : "Web feature done"}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            {kind === "skills" ? (
              <label className="pt-field" htmlFor={ids.desc}>
                <span className="pt-label">Description</span>
                <input id={ids.desc} className="pt-input" value={draft.description} maxLength={300}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
            ) : null}
            <label className="pt-field" htmlFor={ids.body}>
              <span className="pt-label">{kind === "skills" ? "Instructions (markdown)" : "Definition of done"}</span>
              <textarea id={ids.body} className="pt-input pt-textarea" value={draft.body} rows={kind === "skills" ? 8 : 4}
                maxLength={kind === "skills" ? 20000 : 4000} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </label>
            {error ? <p className="pt-error" role="alert">{error}</p> : null}
            <div className="pt-formbar">
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(null); }}>Cancel</Button>
              <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>{draft.id ? "Save" : `Add ${noun}`}</Button>
            </div>
          </div>
        ) : error ? <p className="pt-error" role="alert">{error}</p> : null}

        {items === null ? <p className="pt-hint">Loading…</p> : items.length === 0 && !loadError ? (
          <p className="pt-empty">No {kind === "skills" ? "skills" : "DoD presets"} yet.</p>
        ) : (
          <ul className="pt-list" aria-label={kind === "skills" ? "Skills" : "DoD presets"}>
            {items.map((it) => (
              <li key={it.id} className="pt-row">
                <div className="pt-row-main">
                  <span className={"pt-name" + (kind === "skills" ? " is-mono" : "")}>{it.name}</span>
                  <span className="pt-meta" title={it.body}>{it.description || it.body.split("\n")[0]}</span>
                  {it.source === "template_import" ? <Chip size="sm">Imported</Chip> : null}
                  <span className="pt-meta pt-when" title={it.updated_at}>{relTime(it.updated_at)}</span>
                  {canEdit ? (
                    <span className="pt-rowacts">
                      <IconButton icon="pencil" label={`Edit ${it.name}`} size="sm" onClick={() => { setDraft({ id: it.id, name: it.name, description: it.description || "", body: it.body }); setError(null); }} />
                      <IconButton icon="trash" label={`Delete ${it.name}`} size="sm" disabled={busy} onClick={() => void remove(it)} />
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
