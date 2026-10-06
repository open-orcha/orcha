/**
 * Board — Linear "Agent tasks" board shell (directive D9, image 17).
 *
 *   <Board label="Agent tasks">
 *     <BoardColumn id="lead" title="lead" icon={<Avatar …/>} status={<LivePill …/>} count={4}
 *                  onAdd={…} addLabel="New task for lead" menu={<MenuButton …/>}>
 *       <BoardCard to={`/tasks/${t.id}`} label={t.title}
 *         id="T-2749" topRight={<><LivePill status="working"/><AvatarStack …/></>}
 *         glyph={<StatusGlyph status="in_progress"/>} title={t.title}
 *         chips={<><PriorityBars level={2}/><Chip dot="green">Performance</Chip></>} />
 *     </BoardColumn>
 *   </Board>
 *
 * Columns share the width equally (min 280 px; 4 or fewer usually fill the
 * panel) and scroll horizontally when they don't fit: a thin visible
 * scrollbar, scroll-snap to column starts, and an edge fade on whichever side
 * hides columns (`data-fade`, kept live by `useScrollEdges`) so off-screen
 * columns are never silently cut. At phone width each column is ~86 vw.
 * Cards are real links (`to` / `href`) or buttons (`onClick`); the whole
 * card is the hit target and chips inside must not be interactive (put
 * actions in the column ⋯ menu or the detail view). Empty columns render
 * `empty` (default "No tasks") so a column never collapses to nothing.
 */
import { Children, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../ui";
import { useScrollEdges } from "./FilterPills";

/**
 * `aside` (e.g. Linear's "Hidden columns" strip) is pinned to the board's
 * right edge — sticky while the columns scroll under it, with its own soft
 * left fade — so it is visible at any width instead of only after scrolling
 * to the far end.
 */
export function Board({ label, children, className, aside }: { label: string; children?: ReactNode; className?: string; aside?: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cols = Children.toArray(children).length;
  const hasAside = aside != null && aside !== false;
  useScrollEdges(ref, [cols, hasAside]);
  return (
    <div ref={ref} className={`v2-board${hasAside ? " has-aside" : ""}${className ? " " + className : ""}`} role="region" aria-label={label} tabIndex={0} data-cols={cols}>
      {children}
      {hasAside ? <div className="v2-board-aside">{aside}</div> : null}
    </div>
  );
}

export interface BoardColumnProps {
  id: string;
  title: ReactNode;
  /** Round avatar or glyph before the title. */
  icon?: ReactNode;
  /** Live status next to the title (e.g. a LivePill or StatusDot label). */
  status?: ReactNode;
  count?: number | string | null;
  /** Column menu (⋯) — a MenuButton/IconButton node. */
  menu?: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  empty?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const hasKids = (c: ReactNode): boolean => c != null && c !== false && !(Array.isArray(c) && !c.some(hasKids));

export function BoardColumn({ id, title, icon, status, count, menu, onAdd, addLabel, empty = "No tasks", children, className }: BoardColumnProps) {
  const hid = `v2-bcol-${id.replace(/[^\w-]/g, "_")}`;
  return (
    <section className={`v2-bcol${className ? " " + className : ""}`} aria-labelledby={hid} data-column={id}>
      <header className="v2-bcol-h">
        {icon ? <span className="v2-bcol-ico">{icon}</span> : null}
        <h3 id={hid} className="v2-bcol-title">{title}</h3>
        {status ? <span className="v2-bcol-status">{status}</span> : null}
        {count != null && count !== "" ? <span className="v2-bcol-count">{count}</span> : null}
        <span className="v2-bcol-actions">
          {menu}
          {onAdd ? (
            <button type="button" className="v2-iconbtn v2-iconbtn-sm v2-iconbtn-circle" aria-label={addLabel ?? "Add"} title={addLabel ?? "Add"} onClick={onAdd}>
              <Icon name="plus" cls="v2-ico" />
            </button>
          ) : null}
        </span>
      </header>
      <ul className="v2-bcol-cards" role="list">
        {hasKids(children) ? children : <li className="v2-bcol-empty">{empty}</li>}
      </ul>
    </section>
  );
}

export interface BoardCardProps {
  /** Muted short id, top-left ("T-2749"). */
  id?: ReactNode;
  /** Top-right slot: live pill + avatar(s). */
  topRight?: ReactNode;
  /** Status glyph before the title. */
  glyph?: ReactNode;
  title: ReactNode;
  /** Chip row (priority bars, labels, PR #). Non-interactive. */
  chips?: ReactNode;
  /** Override the accessible name (default: the card's full text). */
  label?: string;
  to?: string;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  dim?: boolean;
  className?: string;
}

export function BoardCard({ id, topRight, glyph, title, chips, label, to, href, onClick, selected, dim, className }: BoardCardProps) {
  const cls = `v2-bcard${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}${className ? " " + className : ""}`;
  const aria = label; // default: the card text (id, status, title, chips) is the accessible name
  const body = (
    <>
      {id != null || topRight ? (
        <span className="v2-bcard-top">
          <span className="v2-bcard-id">{id}</span>
          {topRight ? <span className="v2-bcard-tr">{topRight}</span> : null}
        </span>
      ) : null}
      <span className="v2-bcard-title">
        {glyph ? <span className="v2-bcard-glyph" aria-hidden="true">{glyph}</span> : null}
        <span className="v2-bcard-text">{title}</span>
      </span>
      {chips ? <span className="v2-bcard-chips">{chips}</span> : null}
    </>
  );
  let el: ReactNode;
  if (to != null) el = <Link to={to} className={cls} aria-label={aria} aria-current={selected ? "true" : undefined}>{body}</Link>;
  else if (href != null) el = <a href={href} className={cls} aria-label={aria} aria-current={selected ? "true" : undefined}>{body}</a>;
  else el = <button type="button" className={cls} aria-label={aria} aria-pressed={onClick && selected != null ? selected : undefined} onClick={onClick}>{body}</button>;
  return <li className="v2-bcard-li">{el}</li>;
}
