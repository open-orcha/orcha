/**
 * Settings › General › Objective — the project's stated objective, edited in place
 * (Linear-style: the value is the control; click it, type, ⌘/Ctrl+Enter or Save,
 * Esc or Cancel).
 *
 * Store: `containers.description` (the snapshot's `container.description`) — the
 * Overview summary line and every task's goal chain read it. Written through
 * PUT /api/containers/{cid}/objective {objective, actor_agent_id} (the server mirrors
 * it onto the root task and audit-logs it). Gate: owner or `manage_autonomy`, like the
 * other project-detail writes (the icon); a viewer / non-member / plain member sees the
 * objective read-only with the reason. After a save the snapshot is refreshed, so the
 * Overview shows the new objective without a reload.
 */
import { useEffect, useId, useRef, useState } from "react";
import { sendJSON } from "../../api/client";
import { Button } from "../../components/primitives";
import { useSnapshot } from "../../state/SnapshotProvider";
import { useGrantAuthority } from "./grantAuthority";
import { SettingRow, StatusLine, settingsErrText } from "./settingsUi";

export const OBJECTIVE_MAX = 4000;

/** Plain-words reason a save failed (pure, tested). */
export function objectiveSaveError(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 404 || status === 405) {
    // 404 on an existing project = an older backend without the route
    return "This Embodent can't edit objectives yet — update it, or set one by applying a template.";
  }
  if (typeof status === "number" && status >= 500) return "Couldn't save the objective — Embodent hit an error. Try again.";
  if (status === 413) return `That objective is too long — keep it under ${OBJECTIVE_MAX.toLocaleString()} characters.`;
  const why = settingsErrText(e);
  return "Couldn't save the objective — " + why + (/[.!?]$/.test(why) ? "" : ".");
}

export function ObjectiveRow({ cid, objective }: { cid: string; objective: string | null | undefined }) {
  const { refresh } = useSnapshot();
  const auth = useGrantAuthority("manage_autonomy");
  const current = (objective || "").trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const hintId = useId();

  // a change from elsewhere (another tab, a template apply) shows while not editing
  useEffect(() => { if (!editing) setDraft(current); }, [current, editing]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);
  // autosize the textarea to its content
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [draft, editing]);

  const locked = !auth.can;
  const next = draft.trim();
  const dirty = next !== current;

  const open = () => {
    if (locked) return;
    setDraft(current);
    setError(null);
    setSaved(false);
    setEditing(true);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
  };
  const close = () => {
    setEditing(false);
    setError(null);
    setDraft(current);
    requestAnimationFrame(() => openRef.current?.focus());
  };
  const save = async () => {
    if (busy || locked) return;
    if (!dirty) { close(); return; }
    setBusy(true);
    setError(null);
    try {
      await sendJSON("PUT", "/api/containers/" + encodeURIComponent(cid) + "/objective", {
        objective: next || null,
        actor_agent_id: auth.human ? auth.human.id : null,
      });
      await refresh();
      setEditing(false);
      setSaved(true);
      requestAnimationFrame(() => openRef.current?.focus());
    } catch (e) {
      setError(objectiveSaveError(e));
    }
    setBusy(false);
  };

  const reason = locked && !auth.pending && auth.reason ? auth.reason : null;
  const desc = editing
    ? null
    : saved
      ? <span className="set-obj-saved" role="status">Saved</span>
      : reason
        ? <span data-testid="objective-reason">{reason}</span>
        : "What this project is for. Shown on the Overview and above every task.";

  let body;
  if (editing) {
    const left = OBJECTIVE_MAX - draft.length;
    body = (
      <div className="set-obj-edit">
        <textarea
          ref={taRef}
          id="setObjective"
          className="set-obj-ta"
          rows={2}
          maxLength={OBJECTIVE_MAX}
          value={draft}
          placeholder="What should this project achieve?"
          aria-label="Project objective"
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          disabled={busy}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
        />
        {error ? <StatusLine tone="err" id="setObjectiveErr">{error}</StatusLine> : null}
        <div className="set-obj-bar">
          <span className="set-obj-hint" id={hintId}>
            {left <= 400 ? `${left} characters left · ` : ""}⌘↵ to save · Esc to cancel{!next && current ? " · Saving empty clears it" : ""}
          </span>
          <Button size="sm" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="primary" busy={busy} onClick={() => void save()} id="setObjectiveSave">
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  } else if (locked) {
    body = current
      ? <span className="set-val is-text" id="setObjectiveText">{current}</span>
      : <span className="set-note" id="setObjectiveText">No objective set for this project.</span>;
  } else {
    body = (
      <button
        ref={openRef}
        type="button"
        id="setObjectiveOpen"
        className={"set-obj-view" + (current ? "" : " is-empty")}
        aria-label={current ? "Edit objective: " + current : "Add an objective"}
        onClick={open}
      >
        {current || "Add an objective…"}
      </button>
    );
  }

  return (
    <SettingRow label="Objective" stack desc={desc}>
      {body}
    </SettingRow>
  );
}
