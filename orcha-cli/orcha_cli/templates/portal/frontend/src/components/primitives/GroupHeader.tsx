/**
 * GroupHeader + ListGroup — Linear "My issues" group band (directive D8):
 * a subtle full-width band (slightly lighter than the panel), a caret that
 * collapses the group, a status glyph slot, the group name, a muted count,
 * and a "+" action revealed on hover (always present in the DOM and shown on
 * keyboard focus, so it is never hover-only).
 *
 *   <ListGroup id="in_review" title="In review" count={3} glyph={<StatusGlyph status="review"/>}
 *              onAdd={() => newTask("in_review")} addLabel="New task in In review">
 *     …rows…
 *   </ListGroup>
 *
 * `ListGroup` owns open/closed state (uncontrolled; `defaultOpen`, optional
 * `storageKey` persists it) or is controlled via `open` + `onOpenChange`.
 * `GroupHeader` alone is the band (for custom containers): the caret button
 * carries aria-expanded / aria-controls. `count={null}` renders no number
 * (unknown ≠ 0).
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon } from "../ui";

export interface GroupHeaderProps {
  title: ReactNode;
  count?: number | string | null;
  /** Status / type glyph shown before the title (e.g. a StatusGlyph). */
  glyph?: ReactNode;
  open: boolean;
  onToggle?: () => void;
  /** id of the region this header collapses (aria-controls). */
  controls?: string;
  onAdd?: () => void;
  addLabel?: string;
  /** Extra trailing actions (e.g. a ⋯ menu). */
  actions?: ReactNode;
  /** Heading level for the title (default 3). */
  level?: 2 | 3 | 4;
  className?: string;
}

function Caret() {
  return (
    <svg className="v2-group-caret" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 3.5h5L5 7z" fill="currentColor" />
    </svg>
  );
}

export function GroupHeader({ title, count, glyph, open, onToggle, controls, onAdd, addLabel, actions, level = 3, className }: GroupHeaderProps) {
  const H = `h${level}` as "h2" | "h3" | "h4";
  return (
    <div className={`v2-group${open ? "" : " is-collapsed"}${className ? " " + className : ""}`}>
      <H className="v2-group-h">
        <button
          type="button"
          className="v2-group-toggle"
          aria-expanded={open}
          aria-controls={controls}
          onClick={onToggle}
          disabled={!onToggle}
        >
          <Caret />
          {glyph ? <span className="v2-group-glyph" aria-hidden="true">{glyph}</span> : null}
          <span className="v2-group-title">{title}</span>
          {count != null && count !== "" ? <span className="v2-group-count">{count}</span> : null}
        </button>
      </H>
      {(onAdd || actions) ? (
        <div className="v2-group-actions">
          {actions}
          {onAdd ? (
            <button type="button" className="v2-iconbtn v2-iconbtn-sm v2-iconbtn-circle v2-group-add" aria-label={addLabel ?? "Add"} title={addLabel ?? "Add"} onClick={onAdd}>
              <Icon name="plus" cls="v2-ico" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ListGroupProps extends Omit<GroupHeaderProps, "open" | "onToggle" | "controls"> {
  /** Stable id (used for the region id and persisted state). */
  id: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** localStorage key prefix; state stored as `${storageKey}:${id}`. */
  storageKey?: string;
}

function readStored(key: string | undefined): boolean | null {
  if (!key) return null;
  try {
    const v = localStorage.getItem(key);
    return v === "0" ? false : v === "1" ? true : null;
  } catch {
    return null;
  }
}

export function ListGroup({ id, children, defaultOpen = true, open: openProp, onOpenChange, storageKey, ...header }: ListGroupProps) {
  const key = storageKey ? `${storageKey}:${id}` : undefined;
  const [inner, setInner] = useState<boolean>(() => readStored(key) ?? defaultOpen);
  const open = openProp ?? inner;
  const rid = `v2-group-${useId().replace(/:/g, "")}`;
  useEffect(() => {
    if (!key || openProp != null) return;
    try { localStorage.setItem(key, inner ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [key, inner, openProp]);
  const toggle = () => {
    const next = !open;
    if (openProp == null) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <section className="v2-listgroup" data-group={id}>
      <GroupHeader {...header} open={open} onToggle={toggle} controls={rid} />
      <div id={rid} className="v2-listgroup-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
