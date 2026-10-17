/**
 * Layout primitives: SplitPane (list | inspector with a keyboard-resizable,
 * persisted divider), Inspector (closable / expandable detail pane), Tabs
 * (roving tabindex, ←/→/Home/End, aria-controls), NavTabs (link tab bar),
 * Segmented, Section, Toolbar, Breadcrumbs, EmptyState, Skeleton.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link } from "react-router-dom";
import { IconButton } from "./Button";
import { Icon } from "../ui";

/* ---- SplitPane ------------------------------------------------------------ */
function readWidth(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch { return fallback; }
}

export interface SplitPaneProps {
  list: ReactNode;
  inspector?: ReactNode; // null/undefined = inspector closed, list takes the width
  /** px width of the inspector */
  defaultSize?: number;
  min?: number;
  max?: number;
  /** localStorage key for the persisted width (UI pref, e.g. orcha:v2:tasksInspector) */
  storageKey?: string;
  label?: string;
}

export function SplitPane({ list, inspector, defaultSize = 440, min = 320, max = 760, storageKey, label = "Resize detail pane" }: SplitPaneProps) {
  const [size, setSize] = useState(() => Math.min(max, Math.max(min, readWidth(storageKey, defaultSize))));
  const drag = useRef<{ x: number; w: number; id: number } | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const persist = (w: number) => { if (storageKey) try { localStorage.setItem(storageKey, String(w)); } catch { /* private */ } };
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));

  // End a drag on pointerup, pointercancel AND lostpointercapture — a native
  // dragstart fires pointercancel, and an unhandled cancel left the pane
  // following the cursor after mouseup (QA: sidebar/SplitPane resize).
  const endDrag = () => {
    if (!drag.current) return;
    const id = drag.current.id;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("v2-resizing");
    try { handleRef.current?.releasePointerCapture?.(id); } catch { /* already released */ }
    setSize((w) => { persist(w); return w; });
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      if (e.buttons === 0 && e.pointerType === "mouse") { endDrag(); return; } // button released outside the window
      setSize(clamp(drag.current.w - (e.clientX - drag.current.x)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
      document.body.classList.remove("v2-resizing");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, storageKey]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return; // primary button only (jsdom leaves it undefined)
    e.preventDefault(); // no text selection / native drag (which fires pointercancel)
    drag.current = { x: e.clientX, w: size, id: e.pointerId };
    setDragging(true);
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    document.body.classList.add("v2-resizing");
  };

  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    let w = size;
    if (e.key === "ArrowLeft") w = size + step;
    else if (e.key === "ArrowRight") w = size - step;
    else if (e.key === "Home") w = max;
    else if (e.key === "End") w = min;
    else return;
    e.preventDefault();
    const c = clamp(w);
    setSize(c);
    persist(c);
  };

  return (
    <div className={"v2-split" + (inspector ? " has-inspector" : "")} style={{ ["--v2-inspector-w" as string]: size + "px" }}>
      <div className="v2-split-list">{list}</div>
      {inspector ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={size}
            aria-valuemin={min}
            aria-valuemax={max}
            tabIndex={0}
            ref={handleRef}
            draggable={false}
            className={"v2-split-handle" + (dragging ? " is-dragging" : "")}
            onPointerDown={onPointerDown}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => { const d = clamp(defaultSize); setSize(d); persist(d); }}
            onDragStart={(e) => e.preventDefault()}
            onKeyDown={onKey}
          />
          <div className="v2-split-inspector">{inspector}</div>
        </>
      ) : null}
    </div>
  );
}

/* ---- Inspector ------------------------------------------------------------ */
export function Inspector({ title, meta, onClose, expandHref, onExpand, actions, children, label }: {
  title: ReactNode; meta?: ReactNode; onClose?: () => void; expandHref?: string; onExpand?: () => void;
  actions?: ReactNode; children: ReactNode; label?: string;
}) {
  return (
    <section className="v2-inspector" aria-label={label ?? (typeof title === "string" ? title : "Details")}>
      <header className="v2-inspector-h">
        <div className="v2-inspector-t">
          <div className="v2-inspector-title" title={typeof title === "string" ? title : undefined}>{title}</div>
          {meta ? <div className="v2-inspector-meta">{meta}</div> : null}
        </div>
        <div className="v2-inspector-actions">
          {actions}
          {expandHref ? (
            <a className="v2-iconbtn v2-iconbtn-sm" href={expandHref} aria-label="Open full view" title="Open full view">
              <svg className="v2-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true"><path d="M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3" /></svg>
            </a>
          ) : onExpand ? (
            <IconButton icon="maximize" label="Open full view" size="sm" onClick={onExpand} />
          ) : null}
          {onClose ? <IconButton icon="x" label="Close details" size="sm" onClick={onClose} /> : null}
        </div>
      </header>
      <div className="v2-inspector-b">{children}</div>
    </section>
  );
}

/* ---- Tabs ----------------------------------------------------------------- */
export interface TabSpec { key: string; label: ReactNode; count?: number | null; disabled?: boolean; icon?: string; countTone?: "neutral" | "warn" }

/**
 * Horizontal overflow for a tab strip: keeps the selected tab scrolled into
 * view and toggles has-more-start / has-more-end (edge fades) so off-screen
 * tabs are discoverable at narrow widths.
 */
export function useTabStripOverflow(ref: RefObject<HTMLElement | null>, selectedKey: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const more = el.scrollWidth - el.clientWidth > 1;
      el.classList.toggle("has-more-start", more && el.scrollLeft > 1);
      el.classList.toggle("has-more-end", more && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    const sel = el.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (sel && el.scrollWidth > el.clientWidth) {
      const l = sel.offsetLeft - el.offsetLeft;
      const r = l + sel.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = Math.max(0, l - 24);
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 24;
    }
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", sync); ro?.disconnect(); };
  }, [ref, selectedKey]);
}

function TabInner({ t }: { t: TabSpec }) {
  return (
    <>
      {t.icon ? <Icon name={t.icon} cls="v2-ico" /> : null}
      <span className="v2-tab-label">{t.label}</span>
      {t.count != null ? <span className={"v2-count" + (t.countTone === "warn" ? " v2-tone-warn" : "")}>{t.count > 99 ? "99+" : t.count}</span> : null}
    </>
  );
}

export function Tabs({ tabs, value, onChange, label, idPrefix, className }: {
  tabs: TabSpec[]; value: string; onChange: (key: string) => void; label: string; idPrefix?: string; className?: string;
}) {
  const auto = useId();
  const pre = idPrefix ?? auto;
  const ref = useRef<HTMLDivElement | null>(null);
  useTabStripOverflow(ref, value);
  const enabled = tabs.filter((t) => !t.disabled);
  const onKey = (e: ReactKeyboardEvent) => {
    const i = enabled.findIndex((t) => t.key === value);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = enabled.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(enabled[j].key);
    requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLElement>(`#${CSS.escape(pre + "-tab-" + enabled[j].key)}`);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={"v2-tabs" + (className ? " " + className : "")} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.key}
          id={`${pre}-tab-${t.key}`}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          aria-controls={`${pre}-panel-${t.key}`}
          tabIndex={t.key === value ? 0 : -1}
          disabled={t.disabled}
          className={"v2-tab" + (t.key === value ? " is-selected" : "")}
          onClick={() => onChange(t.key)}
        >
          <TabInner t={t} />
        </button>
      ))}
    </div>
  );
}

/* ---- NavTabs -------------------------------------------------------------- */
/**
 * Linear-style underline tab bar whose tabs are LINKS (e.g. the per-project
 * section bar under the header: Overview · Tasks · Agents · …). Each tab is a
 * real <a>, so URLs/deep links, middle-click and Cmd-click keep working; the
 * current one carries aria-current="page". ←/→/Home/End move focus between
 * tabs (Enter follows the link). Scrolls horizontally with edge fades at
 * narrow widths and keeps the current tab in view.
 */
export interface NavTabSpec { key: string; label: ReactNode; to: string; count?: number | null; countTone?: "neutral" | "warn"; icon?: string; title?: string }

export function NavTabs({ tabs, value, label, className, onNavigate }: {
  tabs: NavTabSpec[]; value: string | null | undefined; label: string; className?: string;
  onNavigate?: (key: string) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useTabStripOverflow(ref, value ?? "");
  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a.v2-tab"));
    const i = links.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % links.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + links.length) % links.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = links.length - 1;
    if (j < 0) return;
    e.preventDefault();
    links[j].focus();
    links[j].scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  return (
    <nav ref={ref} aria-label={label} className={"v2-tabs v2-navtabs" + (className ? " " + className : "")} onKeyDown={onKey}>
      {tabs.map((t) => {
        const cur = t.key === value;
        return (
          <Link
            key={t.key}
            to={t.to}
            className={"v2-tab" + (cur ? " is-selected" : "")}
            aria-current={cur ? "page" : undefined}
            title={t.title}
            data-tab={t.key}
            onClick={onNavigate ? () => onNavigate(t.key) : undefined}
          >
            <TabInner t={{ key: t.key, label: t.label, count: t.count, countTone: t.countTone, icon: t.icon }} />
          </Link>
        );
      })}
    </nav>
  );
}

/* ---- Segmented ------------------------------------------------------------ */
export interface SegmentSpec { key: string; label: ReactNode; count?: number | null; icon?: string; disabled?: boolean; title?: string }

/**
 * Segmented control — ONE style for view/filter/sort toggles, sized to its
 * content (never stretched full-width). role=radiogroup with roving ←/→.
 */
export function Segmented({ items, value, onChange, label, size = "md", className }: {
  items: SegmentSpec[]; value: string; onChange: (key: string) => void; label: string; size?: "sm" | "md"; className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const enabled = items.filter((i) => !i.disabled);
  const onKey = (e: ReactKeyboardEvent) => {
    const i = enabled.findIndex((t) => t.key === value);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = enabled.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(enabled[j].key);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(enabled[j].key)}"]`)?.focus());
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={`v2-seg${size === "sm" ? " v2-seg-sm" : ""}${className ? " " + className : ""}`} onKeyDown={onKey}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          data-seg={it.key}
          aria-checked={it.key === value}
          tabIndex={it.key === value ? 0 : -1}
          disabled={it.disabled}
          title={it.title}
          className="v2-seg-item"
          onClick={() => onChange(it.key)}
        >
          {it.icon ? <Icon name={it.icon} cls="v2-ico" /> : null}
          {it.label}
          {it.count != null ? <span className="v2-count">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ---- Section -------------------------------------------------------------- */
/** A titled block separated by a hairline rule — use instead of nesting cards. */
export function Section({ title, actions, children, className, id }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  const hid = useId();
  return (
    <section className={"v2-section" + (className ? " " + className : "")} aria-labelledby={title ? hid : undefined} id={id}>
      {title || actions ? (
        <div className="v2-section-h">
          {title ? <h3 id={hid} className="v2-section-title">{title}</h3> : null}
          {actions ? <div className="v2-section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function TabPanel({ tabKey, idPrefix, children, active }: { tabKey: string; idPrefix: string; children: ReactNode; active: boolean }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${tabKey}`} aria-labelledby={`${idPrefix}-tab-${tabKey}`} className="v2-tabpanel" tabIndex={0}>
      {children}
    </div>
  );
}

/* ---- Toolbar -------------------------------------------------------------- */
export function Toolbar({ label, children, end }: { label: string; children: ReactNode; end?: ReactNode }) {
  return (
    <div role="toolbar" aria-label={label} className="v2-toolbar">
      <div className="v2-toolbar-main">{children}</div>
      {end ? <div className="v2-toolbar-end">{end}</div> : null}
    </div>
  );
}

/* ---- Breadcrumbs ---------------------------------------------------------- */
export interface Crumb { label: ReactNode; href?: string; title?: string }

/**
 * Crumbs truncate with an ellipsis and ALWAYS carry the full text as a
 * tooltip (explicit `title`, else the string label). `collapsible` hides the
 * ancestors below 600 px so the current section keeps its width.
 */
export function Breadcrumbs({ items, className, collapsible }: { items: Crumb[]; className?: string; collapsible?: boolean }) {
  const shown = items
    .filter((c) => c.label != null && c.label !== "")
    .map((c) => ({ ...c, title: c.title ?? (typeof c.label === "string" || typeof c.label === "number" ? String(c.label) : undefined) }));
  return (
    <nav aria-label="Breadcrumb" className={`v2-crumbs${collapsible ? " is-collapsible" : ""}${className ? " " + className : ""}`}>
      <ol>
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <li key={i} className={last ? "is-current" : undefined}>
              {c.href && !last ? (
                <Link to={c.href} title={c.title}>{c.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined} title={c.title}>{c.label}</span>
              )}
              {!last ? <span className="v2-crumb-sep" aria-hidden="true">/</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ---- EmptyState ----------------------------------------------------------- */
export function EmptyState({ title, body, action, tone = "neutral", icon, compact }: {
  title: string; body?: ReactNode; action?: ReactNode; tone?: "neutral" | "danger" | "warn";
  icon?: string; compact?: boolean;
}) {
  return (
    <div className={`v2-empty v2-empty-${tone}${compact ? " v2-empty-compact" : ""}`} role={tone === "danger" ? "alert" : undefined}>
      {icon ? <div className="v2-empty-icon" aria-hidden="true"><Icon name={icon} cls="v2-ico" /></div> : null}
      <div className="v2-empty-title">{title}</div>
      {body ? <div className="v2-empty-body">{body}</div> : null}
      {action ? <div className="v2-empty-action">{action}</div> : null}
    </div>
  );
}

/* ---- Skeleton ------------------------------------------------------------- */
export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="v2-skeleton" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="v2-skeleton-line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
      <span className="v2-sr">{label}…</span>
    </div>
  );
}
