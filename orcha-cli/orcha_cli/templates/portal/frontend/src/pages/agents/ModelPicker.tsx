/**
 * ModelPicker — the agent Configuration "Model" control (Linear-style popover).
 *
 * Lists EVERY model GET /api/models returns, grouped by the managed-agent runtime
 * it wakes on (claude → Claude Code, codex → Codex), each group and row carrying
 * the provider's real mark (components/primitives/BrandLogo — the same licensed
 * marks Settings → Models & providers uses). Picking a model from the OTHER
 * runtime switches the agent's provider: the runtime follows the model, so the
 * switch goes through the SAME authorized POST /api/agents/{id}/model the parent
 * already uses — after an inline confirm ("Switch forge to Codex · GPT-5.5?").
 *
 * Truthfulness: only runtimes the backend can wake a managed agent on are
 * selectable; desktop-only terminal CLIs (Gemini, Copilot, Cursor…) are not
 * managed-agent runtimes and are never listed — a muted footnote points there.
 *
 * Keyboard: type to filter, ↑/↓ (Home/End) move, Enter picks, Escape backs out
 * of the confirm first, then closes and returns focus to the trigger.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../../components/ui";
import { Popover } from "../../components/primitives";
import { BrandLogo } from "../../components/primitives/BrandLogo";
import "./modelPicker.css";

export type ManagedRuntime = "claude" | "codex";

/** The managed-agent runtimes the backend wakes agents on (model_policy.py). */
export const MANAGED_RUNTIMES: { id: ManagedRuntime; name: string; brand: string }[] = [
  { id: "claude", name: "Claude", brand: "claude" },
  { id: "codex", name: "Codex", brand: "codex" },
];
export function runtimeName(r: string): string {
  return r === "codex" ? "Codex" : "Claude";
}

export interface PickerModel {
  id: string;
  name: string;
  runtime?: string;
  reasoning_efforts?: string[];
}

export interface ModelPickerProps {
  agentAlias: string;
  models: PickerModel[];
  /** the agent's runtime right now (follows its model) */
  runtime: ManagedRuntime;
  /** the model to mark "current" (the saved id, else the default that applies) */
  currentId: string;
  /** the saved model is a legacy id outside the catalog (shown first, not pickable) */
  legacyId: string | null;
  legacyLabel?: string;
  defaultId: string;
  /** trigger text (the current value) + tooltip */
  label: string;
  title?: string;
  /** "" = allowed; otherwise the permission reason every option carries */
  lockReason: string;
  /** effort id → display name, for the per-row support hint */
  effortName: (id: string) => string;
  onPick: (modelId: string) => void;
  /** open request from the Provider control: open on that runtime's group */
  openOn?: { runtime: ManagedRuntime; n: number } | null;
}

interface Row {
  m: PickerModel;
  rt: ManagedRuntime;
  legacy?: boolean;
}

/** A model's managed runtime, or null when the backend tags it with one the portal can't run. */
export function managedRuntimeOf(m: { id: string; runtime?: string }): ManagedRuntime | null {
  if (m.runtime) {
    const r = String(m.runtime).toLowerCase();
    return r === "codex" ? "codex" : r === "claude" ? "claude" : null;
  }
  return String(m.id).startsWith("gpt-") ? "codex" : "claude";
}

function effortHint(m: PickerModel, effortName: (id: string) => string): { text: string; title: string } | null {
  if (!Array.isArray(m.reasoning_efforts)) return null;
  if (!m.reasoning_efforts.length) return { text: "No effort control", title: "This model has no reasoning-effort setting" };
  const names = m.reasoning_efforts.map(effortName);
  return { text: "Effort to " + names[names.length - 1], title: "Reasoning effort: " + names.join(", ") };
}

export function ModelPicker(p: ModelPickerProps) {
  const { agentAlias, models, runtime, currentId, legacyId, defaultId, lockReason, effortName, onPick } = p;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement | null>(null);
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const locked = !!lockReason;

  const all: Row[] = useMemo(() => {
    const rows: Row[] = [];
    for (const r of MANAGED_RUNTIMES) {
      if (legacyId && r.id === runtime) rows.push({ m: { id: legacyId, name: p.legacyLabel || legacyId }, rt: r.id, legacy: true });
      for (const m of models) if (managedRuntimeOf(m) === r.id) rows.push({ m, rt: r.id });
    }
    return rows;
  }, [models, legacyId, runtime, p.legacyLabel]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((r) => (r.m.name + " " + r.m.id + " " + runtimeName(r.rt)).toLowerCase().includes(needle))
    : all;
  const pickable = shown.filter((r) => !r.legacy && !locked);
  const optId = (id: string) => uid + "-o-" + id.replace(/[^a-zA-Z0-9_-]/g, "_");

  const close = () => {
    setOpen(false);
    setConfirm(null);
    setQ("");
  };
  const openAt = (rt: ManagedRuntime | null) => {
    setQ("");
    setConfirm(null);
    const inRt = rt ? all.filter((r) => r.rt === rt && !r.legacy) : [];
    const first = rt
      ? inRt.find((r) => r.m.id === currentId) || inRt.find((r) => r.m.id === defaultId) || inRt[0]
      : all.find((r) => r.m.id === currentId && !r.legacy) || all.find((r) => !r.legacy);
    setActive(first ? first.m.id : null);
    setOpen(true);
  };

  // the Provider control asks to open on a runtime's group
  const lastReq = useRef(0);
  useEffect(() => {
    if (!p.openOn || p.openOn.n === lastReq.current) return;
    lastReq.current = p.openOn.n;
    openAt(p.openOn.runtime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.openOn]);

  // keep the active row valid under the filter, and in view
  useEffect(() => {
    if (!open) return;
    if (!pickable.some((r) => r.m.id === active)) setActive(pickable[0] ? pickable[0].m.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needle, locked]);
  useEffect(() => {
    if (!open || !active) return;
    const el = document.getElementById(optId(active));
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);
  useEffect(() => {
    if (confirm) confirmBtn.current?.focus();
  }, [confirm]);

  const choose = (r: Row) => {
    if (r.legacy || locked) return;
    if (r.m.id === currentId && !legacyId) return close();
    if (r.rt !== runtime) {
      setActive(r.m.id);
      setConfirm(r);
      return;
    }
    close();
    onPick(r.m.id);
  };
  const doSwitch = () => {
    if (!confirm) return;
    const id = confirm.m.id;
    close();
    onPick(id);
    trigger.current?.focus();
  };
  const cancelConfirm = () => {
    setConfirm(null);
    document.getElementById(uid + "-q")?.focus();
  };

  const onFilterKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const ids = pickable.map((r) => r.m.id);
    const i = active ? ids.indexOf(active) : -1;
    let j = -1;
    if (e.key === "ArrowDown") j = ids.length ? (i + 1) % ids.length : -1;
    else if (e.key === "ArrowUp") j = ids.length ? (i - 1 + ids.length) % ids.length : -1;
    else if (e.key === "Home" && e.altKey) j = 0;
    else if (e.key === "End" && e.altKey) j = ids.length - 1;
    else if (e.key === "Enter") {
      e.preventDefault();
      const r = pickable.find((x) => x.m.id === active);
      if (r) choose(r);
      return;
    }
    if (j >= 0) {
      e.preventDefault();
      setActive(ids[j]);
    }
  };
  const onPopKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Escape backs out of the confirm before it closes the popover
    if (e.key === "Escape" && confirm) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation?.();
      cancelConfirm();
    }
  };

  const listId = uid + "-list";
  const groups = MANAGED_RUNTIMES.map((r) => ({ r, rows: shown.filter((x) => x.rt === r.id) })).filter((g) => g.rows.length);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={p.title}
        className="v2-btn v2-btn-secondary v2-btn-sm v2-menubtn ag-pick-btn mpk-trigger"
        onClick={() => (open ? close() : openAt(null))}
      >
        <BrandLogo brand={runtime} size={14} className="mpk-logo" />
        <span className="v2-btn-label">{p.label}</span>
        <Icon name="chev" cls="v2-ico v2-btn-ico v2-btn-ico-r" />
      </button>
      <Popover
        anchor={trigger}
        open={open}
        onClose={close}
        role="dialog"
        label={"Model for " + agentAlias}
        placement="bottom-end"
        className="mpk-pop"
        id={uid + "-pop"}
      >
        <div className="mpk" onKeyDown={onPopKey}>
          <div className="mpk-q">
            <Icon name="search" cls="v2-ico" />
            <input
              id={uid + "-q"}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active && !confirm ? optId(active) : undefined}
              aria-label="Filter models"
              placeholder="Filter models…"
              value={q}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQ(e.target.value);
                setConfirm(null);
              }}
              onKeyDown={onFilterKey}
            />
          </div>
          <div className="mpk-list" role="listbox" id={listId} aria-label="Models">
            {groups.map(({ r, rows }) => (
              <div key={r.id} role="group" aria-labelledby={uid + "-g-" + r.id} className="mpk-group" data-runtime={r.id}>
                <div className="mpk-gh" id={uid + "-g-" + r.id}>
                  <BrandLogo brand={r.brand} size={14} className="mpk-logo" />
                  <span className="mpk-gh-t">{r.name}</span>
                  {r.id === runtime ? <span className="mpk-gh-cur">Current provider</span> : null}
                </div>
                {rows.map((row) => {
                  const isCur = row.legacy || (!legacyId && row.m.id === currentId);
                  const hint = row.legacy ? null : effortHint(row.m, effortName);
                  const dis = row.legacy || locked;
                  return (
                    <div
                      key={row.m.id + (row.legacy ? ":legacy" : "")}
                      id={row.legacy ? undefined : optId(row.m.id)}
                      role="option"
                      aria-selected={isCur}
                      aria-disabled={dis || undefined}
                      data-model={row.m.id}
                      title={row.legacy ? row.m.id + " — not in the curated list; pick a model to switch" : dis ? lockReason : row.m.id}
                      className={"mpk-opt" + (active === row.m.id && !row.legacy ? " is-active" : "") + (isCur ? " is-cur" : "")}
                      onMouseMove={() => { if (!dis && active !== row.m.id && !confirm) setActive(row.m.id); }}
                      onMouseDown={(e) => e.preventDefault() /* keep focus in the filter */}
                      onClick={() => choose(row)}
                    >
                      <BrandLogo brand={r.brand} size={14} className="mpk-logo" />
                      <span className="mpk-name">
                        {row.m.name}
                        {row.m.id === defaultId && !row.legacy ? <span className="mpk-def"> · default</span> : null}
                      </span>
                      {row.legacy ? null : <span className="mpk-id">{row.m.id}</span>}
                      <span className="grow" />
                      {hint ? <span className="mpk-hint" title={hint.title}>{hint.text}</span> : null}
                      <span className="mpk-check" aria-hidden="true">{isCur ? <Icon name="check" cls="v2-ico" /> : null}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {!groups.length ? <div className="mpk-none">No models match “{q.trim()}”</div> : null}
          </div>
          {confirm ? (
            <div className="mpk-confirm" role="group" aria-label="Confirm provider switch">
              <BrandLogo brand={confirm.rt} size={14} className="mpk-logo" />
              <span className="mpk-confirm-t">
                Switch {agentAlias} to {runtimeName(confirm.rt)} · {confirm.m.name}?
              </span>
              <span className="grow" />
              <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={cancelConfirm}>Cancel</button>
              <button type="button" ref={confirmBtn} className="v2-btn v2-btn-primary v2-btn-sm mpk-switch" onClick={doSwitch}>Switch</button>
            </div>
          ) : (
            <div className="mpk-foot">
              {locked ? (
                <span className="mpk-lock"><Icon name="shield" cls="v2-ico" />{lockReason}</span>
              ) : (
                <span>Other agents can be launched in desktop terminals (Settings → Agents)</span>
              )}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
