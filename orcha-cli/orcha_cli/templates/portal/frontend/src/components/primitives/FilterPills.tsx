/**
 * FilterPills + FilterBar — the Linear view-filter row (directive D5):
 * rounded-full chips ("All tasks · Active · Backlog"), the selected one filled
 * with a subtle surface, circular IconButtons on the right.
 *
 *   <FilterBar actions={<><IconButton variant="outline" icon="sliders" label="Display options"/>…</>}>
 *     <FilterPills label="Task scope" value={scope} onChange={setScope}
 *       items={[{ key: "all", label: "All tasks" }, { key: "active", label: "Active", count: 4 }]} />
 *   </FilterBar>
 *
 * Single-select (radiogroup, roving ←/→/Home/End). `count` renders a muted
 * tabular number; `count={null}` renders nothing (unknown ≠ 0). Items with
 * `to` render as router links (aria-current) for URL-driven views; otherwise
 * `onChange(key)` is called — keep the value in the URL with `replace`.
 *
 * Overflow (phones, long pill sets): the row scrolls sideways, the cut edge
 * fades (`data-fade="start|end"`, set by `useScrollEdges`) and the selected
 * pill is scrolled into view (centred) whenever the value changes, so the
 * active filter is never off-screen. `useScrollEdges` / `revealSelected` are
 * exported for other horizontally scrolling strips (tab bars, boards).
 */
import { useLayoutEffect, useRef, type DependencyList, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../ui";

export interface FilterPillSpec {
  key: string;
  label: ReactNode;
  count?: number | string | null;
  /** Icon name (components/ui) or a custom node, shown before the label. */
  icon?: string | ReactNode;
  title?: string;
  disabled?: boolean;
  /** Render as a router link to this path (URL-driven filters). */
  to?: string;
}

export interface FilterPillsProps {
  items: FilterPillSpec[];
  value: string;
  onChange?: (key: string) => void;
  /** Accessible name of the group ("Task scope"). */
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/* ---- horizontal overflow helpers (shared with Board / tab strips) ---------- */

/** Which edges of a horizontal scroller hide content: "", "start", "end" or "start end". */
export function scrollEdges(el: HTMLElement): string {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 1) return "";
  const out: string[] = [];
  if (el.scrollLeft > 1) out.push("start");
  if (el.scrollLeft < max - 1) out.push("end");
  return out.join(" ");
}

/** Keep `data-fade` on a horizontal scroller in sync with its hidden edges (CSS masks read it). */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, deps: DependencyList = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => {
      const f = scrollEdges(el);
      if (f) el.setAttribute("data-fade", f);
      else el.removeAttribute("data-fade");
    };
    upd();
    el.addEventListener("scroll", upd, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(upd) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", upd);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Scroll `child` into the horizontal viewport of `scroller` (centred) when it is
 * clipped. Only the scroller moves — never the page (unlike scrollIntoView).
 */
export function revealSelected(scroller: HTMLElement, child: HTMLElement | null | undefined) {
  if (!child) return;
  const sr = scroller.getBoundingClientRect();
  const cr = child.getBoundingClientRect();
  if (cr.left >= sr.left && cr.right <= sr.right) return;
  const delta = cr.left + cr.width / 2 - (sr.left + sr.width / 2);
  scroller.scrollLeft += delta;
}

function PillInner({ it }: { it: FilterPillSpec }) {
  return (
    <>
      {typeof it.icon === "string" ? <Icon name={it.icon} cls="v2-ico v2-pill-ico" /> : it.icon ?? null}
      <span className="v2-pill-label">{it.label}</span>
      {it.count != null && it.count !== "" ? <span className="v2-pill-count">{it.count}</span> : null}
    </>
  );
}

export function FilterPills({ items, value, onChange, label, size = "md", className }: FilterPillsProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const linkMode = items.some((i) => i.to != null);
  const cls = `v2-pills${size === "sm" ? " v2-pills-sm" : ""}${className ? " " + className : ""}`;
  const sig = items.map((i) => `${i.key}:${i.count ?? ""}`).join("|");
  useScrollEdges(ref, [sig]);
  // the selected pill is never left off-screen (390 px rows, deep links)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    revealSelected(el, el.querySelector<HTMLElement>('[aria-checked="true"], [aria-current]'));
  }, [value, sig]);

  if (linkMode) {
    return (
      <nav ref={ref as RefObject<HTMLElement>} aria-label={label} className={cls}>
        {items.map((it) => (
          <Link
            key={it.key}
            to={it.to ?? "#"}
            replace
            className="v2-pill"
            aria-current={it.key === value ? "true" : undefined}
            title={it.title}
            data-pill={it.key}
            onClick={() => onChange?.(it.key)}
          >
            <PillInner it={it} />
          </Link>
        ))}
      </nav>
    );
  }

  const enabled = items.filter((i) => !i.disabled);
  const onKey = (e: ReactKeyboardEvent) => {
    if (!enabled.length) return;
    const i = enabled.findIndex((t) => t.key === value);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = enabled.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange?.(enabled[j].key);
    const k = enabled[j].key;
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-pill="${CSS.escape(k)}"]`)?.focus());
  };
  const hasSelected = items.some((i) => i.key === value && !i.disabled);
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={cls} onKeyDown={onKey}>
      {items.map((it) => {
        const on = it.key === value;
        // roving tabindex; if nothing is selected the first enabled pill is the tab stop
        const tabStop = on || (!hasSelected && it === enabled[0]);
        return (
          <button
            key={it.key}
            type="button"
            role="radio"
            data-pill={it.key}
            aria-checked={on}
            tabIndex={tabStop ? 0 : -1}
            disabled={it.disabled}
            title={it.title}
            className="v2-pill"
            onClick={() => onChange?.(it.key)}
          >
            <PillInner it={it} />
          </button>
        );
      })}
    </div>
  );
}

/** Filter row under the panel header: pills (children) left, circular actions right. */
export function FilterBar({ children, actions, className }: { children?: ReactNode; actions?: ReactNode; className?: string }) {
  const main = useRef<HTMLDivElement | null>(null);
  useScrollEdges(main);
  return (
    <div className={`v2-filterbar${className ? " " + className : ""}`}>
      <div ref={main} className="v2-filterbar-main">{children}</div>
      {actions ? <div className="v2-filterbar-actions">{actions}</div> : null}
    </div>
  );
}
