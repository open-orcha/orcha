/**
 * Project section TABS (product directive D1) — rendered by <Shell> INSIDE the
 * panel header (D5: one header area, never a second stacked bar) whenever a
 * project section is open (Overview, Tasks, Agents, Requests, Code, GitHub,
 * Activity, Metrics). Wide panels: inline after the project crumb; narrow
 * panels: the header's second row. The sidebar no longer repeats these
 * per-project children.
 *
 * Linear-style underline tabs. These are NAVIGATION (each tab is a real URL —
 * the existing routes / deep links are unchanged), so the markup is a
 * <nav> of links with aria-current="page", not an ARIA tablist (a tablist
 * implies in-page panels). Keyboard: every tab is a normal Tab stop; ←/→/Home/
 * End additionally move focus along the bar. At narrow widths the bar scrolls
 * horizontally and keeps the current tab in view.
 *
 * No visible counts (Linear-style; review: "Tasks 7" beside an "All tasks 10"
 * pill named two totals for one noun). The shared selector's count (nav.ts
 * sectionCounts) stays in each tab's tooltip + accessible name, labelled with
 * what it measures ("15 open tasks").
 */
import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSnapshot } from "../state/SnapshotProvider";
import { Icon } from "../components/ui";
import { useTabStripOverflow } from "../components/primitives/Layout";
import { isSectionCurrent, projectSections, sectionCounts } from "./nav";
import { sectionsForMode, useProjectMode } from "../lib/projectMode";

/** Shell `page` keys that belong to a project (the tab bar shows for these only). */
export function isProjectSectionPage(page: string): boolean {
  return projectSections().some((s) => s.key === page);
}

/** Compact count text: 1234 → "999+" style cap keeps the bar stable. */
export function tabCountText(n: number): string {
  return n > 999 ? "999+" : String(n);
}

/** Width of the strip's start fade (px) — a scrolled strip parks a tab edge right here. */
export const TAB_FADE_START = 28;

/**
 * Scroll the current tab toward the strip's centre when the strip overflows
 * (pure DOM, tested) — then SNAP so a tab starts exactly at the start fade.
 * The hidden tab's tail therefore sits entirely under the fully transparent
 * part of the mask: no legible "ew" fragment of "Overview" next to the
 * project avatar at 390 px (review M2 / N8).
 */
export function centerCurrentTab(strip: HTMLElement | null): void {
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  const cur = strip.querySelector<HTMLElement>('[aria-current="page"]');
  if (!cur) return;
  const max = strip.scrollWidth - strip.clientWidth;
  const ideal = cur.offsetLeft - strip.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("a.v2-ptab"));
  // snap points: 0 (first tab flush) and every later tab's left edge minus the fade
  const snaps = [0, ...tabs.slice(1).map((t) => t.offsetLeft - strip.offsetLeft - TAB_FADE_START)]
    .filter((x) => x >= 0 && x <= max);
  // keep the current tab fully visible past the fades
  const curL = cur.offsetLeft - strip.offsetLeft;
  const curR = curL + cur.offsetWidth;
  const fits = (x: number) => (x === 0 ? curL >= 0 : curL >= x + TAB_FADE_START) && curR <= x + strip.clientWidth - (x >= max - 1 ? 0 : 28);
  const ok = snaps.filter(fits);
  const best = ok.length ? ok.reduce((b, x) => (Math.abs(x - ideal) < Math.abs(b - ideal) ? x : b), ok[0]) : ideal;
  strip.scrollLeft = Math.max(0, Math.min(best, max));
}

/** Is the current tab fully clear of both edge fades? (pure DOM, tested) */
export function currentTabVisible(strip: HTMLElement | null): boolean {
  if (!strip || strip.scrollWidth <= strip.clientWidth) return true;
  const cur = strip.querySelector<HTMLElement>('[aria-current="page"]');
  if (!cur) return true;
  const l = cur.offsetLeft - strip.offsetLeft, r = l + cur.offsetWidth;
  const max = strip.scrollWidth - strip.clientWidth;
  const s = strip.scrollLeft;
  const startClear = s <= 1 ? 0 : TAB_FADE_START;
  const endClear = s >= max - 1 ? 0 : TAB_FADE_START;
  return l >= s + startClear && r <= s + strip.clientWidth - endClear;
}

export function ProjectTabs({ page }: { page: string }) {
  const { snap, cid } = useSnapshot();
  const location = useLocation();
  const ref = useRef<HTMLDivElement | null>(null);
  // General (non-code) projects hide the Code and GitHub tabs (presentation only)
  const sections = sectionsForMode(projectSections(), useProjectMode(cid).mode);
  const counts = sectionCounts(snap);
  const projectName = snap?.container?.name || "Project";

  // The Shell `page` prop is authoritative (a page mounted at a nested path
  // still lights its tab); fall back to the pathname match.
  const currentKey = sections.find((s) => s.key === page)?.key
    ?? sections.find((s) => isSectionCurrent(s.href, location.pathname))?.key
    ?? null;

  // keep the current tab visible when the strip scrolls; toggles has-more-end
  // (edge fade) so off-screen tabs stay discoverable
  useTabStripOverflow(ref, currentKey ?? "");
  // …and centred when the strip overflows (390 px: the active "GitHub" tab was
  // scrolled off-screen as "Gi…")
  useLayoutEffect(() => { centerCurrentTab(ref.current); }, [currentKey]);
  // …and again whenever the strip's width changes (header density settles
  // AFTER the first paint; the project name / sidebar take room): a strip that
  // shrank under the current tab must bring it back (review: 390 showed
  // "Reques" cut by the end fade).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      if (!currentTabVisible(el)) centerCurrentTab(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentKey]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const links = Array.from(ref.current?.querySelectorAll<HTMLAnchorElement>("a.v2-ptab") ?? []);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
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
    <nav className="v2-ptabs" aria-label={`${projectName} sections`}>
      <div ref={ref} className="v2-ptabs-scroll" onKeyDown={onKeyDown}>
        {sections.map((s) => {
          const c = counts[s.key];
          const current = s.key === currentKey;
          const countTitle = c && c.n != null ? `${c.n} ${c.title}` : undefined;
          return (
            <Link
              key={s.key}
              to={s.href}
              className={"v2-ptab" + (current ? " is-current" : "")}
              aria-current={current ? "page" : undefined}
              title={countTitle ? `${s.label} · ${countTitle}` : undefined}
              data-section={s.key}
            >
              <Icon name={s.icon} cls="v2-ico v2-ptab-ico" />
              <span className="v2-ptab-label">{s.label}</span>
              {countTitle ? <span className="v2-sr">, {countTitle}</span> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
