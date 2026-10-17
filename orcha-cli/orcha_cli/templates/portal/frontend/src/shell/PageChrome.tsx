/**
 * Page chrome for the D5 app frame — the pieces a page composes under the
 * unified panel header (Linear "pop" frame, docs/orcha-v2-design-system.md §4).
 *
 *   <Shell page="tasks" title="Tasks"
 *     toolbar={
 *       <PageToolbar label="Task filters" end={<>
 *         <CircleIconButton icon="sliders" label="Display options" onClick={…} />
 *       </>}>
 *         <FilterPills label="Show" value={view} onChange={setView}
 *           items={[{ key: "all", label: "All" }, { key: "active", label: "Active", count: 12 }]} />
 *       </PageToolbar>
 *     }>
 *
 * - `PageToolbar`  — the filter-pill row: pills left, circular icon buttons
 *   right. Pass it as `<Shell toolbar>` (a fixed slot under the header that
 *   never scrolls away) or render it first inside the page content.
 * - `FilterPills`  — re-export of the primitives' rounded-full view/filter
 *   chips (components/primitives/FilterPills; radiogroup, roving ←/→).
 * - `CircleIconButton` — `IconButton variant="outline"`: 28 px circle, 1 px
 *   border (label required → aria-label + tooltip; `pressed` for toggles).
 * - `PageHeader` — Linear detail header row: status glyph · muted short ID ·
 *   title · trailing (☆ / ⋯) … right: actions + `Pager` ("1 / 84 ↑ ↓").
 * - `scrollMainTo(top)` — scroll the page content. On wide layouts the content
 *   scrolls INSIDE the inset panel (not the window); use this instead of
 *   `window.scrollTo`.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { IconButton, type IconButtonProps } from "../components/primitives/IconButton";
import { FilterPills, revealSelected, type FilterPillSpec, type FilterPillsProps } from "../components/primitives/FilterPills";

/* ---- CircleIconButton ----------------------------------------------------- */
export type CircleIconButtonProps = Omit<IconButtonProps, "variant" | "shape">;

/** 28 px circular, 1 px border (D5) = `IconButton variant="outline"`. Same a11y contract. */
export function CircleIconButton(props: CircleIconButtonProps) {
  return <IconButton {...props} variant="outline" shape="circle" />;
}

/* ---- FilterPills ---------------------------------------------------------- */
// ONE implementation, owned by the primitives (components/primitives/FilterPills).
export { FilterPills, type FilterPillSpec, type FilterPillsProps };

/* ---- PageToolbar ---------------------------------------------------------- */
/**
 * The filter-pill row under the panel header: pills left, circular icon
 * buttons right. Same look as the primitives' `FilterBar`, plus a named
 * `role="toolbar"`; as `<Shell toolbar>` it sits in a fixed slot under the
 * header with the panel's own gutters.
 */
export function PageToolbar({ label, children, end, className }: {
  /** accessible name, e.g. "Task filters" */
  label: string;
  /** left side: FilterPills, search field, MenuButtons… */
  children?: ReactNode;
  /** right side: CircleIconButtons (filter, display options, view toggle) */
  end?: ReactNode;
  className?: string;
}) {
  // The row's MAIN area is the horizontal scroller at phone width (the pills'
  // own group doesn't scroll there), so the selected pill is revealed here —
  // on mount and whenever the selection moves, never on unrelated renders.
  const mainRef = useRef<HTMLDivElement | null>(null);
  const shown = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const sel = main.querySelector<HTMLElement>('[aria-checked="true"], [aria-current="true"], [aria-current="page"]');
    if (sel === shown.current) return;
    shown.current = sel;
    if (sel && main.scrollWidth > main.clientWidth) revealSelected(main, sel);
  });
  return (
    <div role="toolbar" aria-label={label} className={"v2-filterbar v2-pagebar" + (className ? " " + className : "")}>
      <div ref={mainRef} className="v2-filterbar-main">{children}</div>
      {end ? <div className="v2-filterbar-actions">{end}</div> : null}
    </div>
  );
}

/* ---- Pager ("1 / 84 ↑ ↓") ------------------------------------------------- */
export function Pager({ index, total, onPrev, onNext, noun = "item" }: {
  /** 0-based position of the open item in its list */
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  noun?: string;
}) {
  if (total <= 0 || index < 0) return null;
  const pos = `${index + 1} / ${total}`;
  return (
    <div className="v2-pager" role="group" aria-label={`${noun} ${index + 1} of ${total}`}>
      <span className="v2-pager-pos tnum" aria-hidden="true">{pos}</span>
      <IconButton icon="arrow-up" label={`Previous ${noun}`} size="sm" disabled={!onPrev || index <= 0} onClick={onPrev} />
      <IconButton icon="arrow-down" label={`Next ${noun}`} size="sm" disabled={!onNext || index >= total - 1} onClick={onNext} />
    </div>
  );
}

/* ---- PageHeader (detail views) ------------------------------------------- */
export function PageHeader({ glyph, id, title, trailing, actions, pager, className, titleAs = "h1" }: {
  /** element for the title. Default `h1`; pass `"div"` when the page body
   *  already renders the document h1 (e.g. a large Display title). */
  titleAs?: "h1" | "h2" | "div";
  /** status glyph / page icon (e.g. <StatusDot showLabel={false} />) */
  glyph?: ReactNode;
  /** muted short ID ("ORC-128", "#a1b2c3d4") */
  id?: ReactNode;
  title: ReactNode;
  /** right after the title: ☆ / ⋯ menu */
  trailing?: ReactNode;
  /** right side: CircleIconButtons */
  actions?: ReactNode;
  pager?: ReactNode;
  className?: string;
}) {
  const t = typeof title === "string" ? title : undefined;
  return (
    <div className={"v2-pagehead" + (className ? " " + className : "")}>
      {glyph ? <span className="v2-pagehead-glyph">{glyph}</span> : null}
      {id ? <span className="v2-pagehead-id">{id}</span> : null}
      {titleAs === "h1" ? <h1 className="v2-pagehead-title" title={t}>{title}</h1>
        : titleAs === "h2" ? <h2 className="v2-pagehead-title" title={t}>{title}</h2>
        : <div className="v2-pagehead-title" title={t}>{title}</div>}
      {trailing ? <span className="v2-pagehead-trail">{trailing}</span> : null}
      <span className="v2-grow" />
      {actions ? <div className="v2-pagehead-actions">{actions}</div> : null}
      {pager}
    </div>
  );
}

/* ---- content scrolling ---------------------------------------------------- */
/**
 * Scroll the page content to `top`. Wide layouts scroll inside the inset
 * panel (`#main.v2-content`); narrow layouts (drawer, ≤ 900 px) scroll the
 * document. Works for both — use it instead of `window.scrollTo`.
 */
export function scrollMainTo(top: number, behavior: ScrollBehavior = "auto"): void {
  const main = typeof document !== "undefined" ? document.getElementById("main") : null;
  try {
    if (main && main.scrollHeight > main.clientHeight && getComputedStyle(main).overflowY !== "visible") {
      main.scrollTo?.({ top, behavior });
      return;
    }
  } catch { /* jsdom */ }
  try { window.scrollTo({ top, behavior }); } catch { /* jsdom */ }
}

/** Current content scroll offset (panel scroller on wide layouts, else the window). */
export function mainScrollTop(): number {
  const main = typeof document !== "undefined" ? document.getElementById("main") : null;
  if (main && main.scrollTop > 0) return main.scrollTop;
  return typeof window !== "undefined" ? window.scrollY || 0 : 0;
}
