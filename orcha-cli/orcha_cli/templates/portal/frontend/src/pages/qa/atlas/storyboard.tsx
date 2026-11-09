import { ArrowRight } from "../map/kit/icons";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";
import board from "./board.module.css";
import { areaCountWords, areaSummary, capturing, layoutRow, LEADS_SHOWN, LOOKS_DIFFERENT, moveWords, shapesOf, type AreaRow } from "./model";
import { ScreenCard } from "./screen-card";
import type { Atlas, Platform } from "./types";

/** At most this many dots say an area's screens; more is "+N". */
const DOTS = 24;

/** One dot per screen of an area, in walking order: filled when seen live, amber when its
 * platforms read differently, an outline when no run has seen it yet. Decorative: the count beside
 * it says the same in words. */
function SeenDots({ screens }: { screens: readonly { never_seen: boolean; similarity: { badge: string } | null }[] }) {
  const shown = screens.slice(0, DOTS);
  return (
    <span className={board.dots} aria-hidden data-atlas-area-dots>
      {shown.map((s, i) => (
        <i key={i} data-seen={!s.never_seen || undefined} data-differs={(s.similarity && LOOKS_DIFFERENT.includes(s.similarity.badge as never)) || undefined} />
      ))}
      {screens.length > DOTS ? <span className={board.dotsMore}>+{screens.length - DOTS}</span> : null}
    </span>
  );
}

/** Each arrow a beat after the one before, so the flow reads in walking order. */
const delay = (k: number) => ({ "--d": `${Math.min(k, 12) * 70}ms` }) as CSSProperties;

/**
 * Where an area's screens lead out to: the first `LEADS_SHOWN` areas by name, each a link to its
 * row, then "+N more" opening the rest in a popover, so the header stays on one line.
 */
function LeadsTo({ areas, onGo }: { areas: { key: string; name: string; label: string }[]; onGo: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const shown = areas.slice(0, LEADS_SHOWN);
  const rest = areas.length - shown.length;
  const link = "rounded hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-ring";
  return (
    <span ref={box} className="relative flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-muted" data-atlas-leads>
      <ArrowRight className="size-3 shrink-0" aria-hidden />
      leads to
      {shown.map((a, i) => (
        <span key={a.key}>
          <button type="button" className={link} onClick={() => onGo(a.key)} title={moveWords(a.label)}>
            {a.name}
          </button>
          {i < shown.length - 1 ? "," : null}
        </span>
      ))}
      {rest > 0 ? (
        <button
          type="button"
          className={cn(link, "rounded-full border border-border px-1.5 leading-4")}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          data-atlas-leads-more
        >
          +{rest} more
        </button>
      ) : null}
      {open ? (
        <span id={id} role="dialog" aria-label="Every area it leads to" className={styles.popover} data-atlas-leads-popover>
          {areas.map((a) => (
            <button
              key={a.key}
              type="button"
              className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                setOpen(false);
                onGo(a.key);
              }}
            >
              <span className="font-medium text-fg">{a.name}</span>
              <span className="truncate text-xs text-muted">{moveWords(a.label)}</span>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** One area: its name, its counts, and its screens left to right with the flow between them. */
const AreaStrip = memo(function AreaStrip({
  row,
  atlas,
  platforms,
  arrows,
  fresh,
  onOpen,
  onArea,
  onGoArea,
  drawKey,
  index,
  glow,
  fillOn,
  onFill,
  wrapWidth,
}: {
  row: AreaRow;
  atlas: Atlas;
  platforms: Platform[];
  arrows: boolean;
  fresh: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onArea: (key: string) => void;
  onGoArea: (key: string) => void;
  /** Above 0 the arrows were just turned on: they draw in, one after another. */
  drawKey: number;
  /** The row's place on the storyboard, from 0. */
  index: number;
  /** Cards lit one after another (a refresh's new screenshots, a jump), by their order. */
  glow: ReadonlyMap<string, number> | null;
  /** The platforms a "Fill in" can start on now (none while a pass runs). */
  fillOn?: ReadonlySet<Platform>;
  onFill?: (platform: Platform) => void;
  /** The width the row's cards wrap to (the board's, inside its padding); none: one line. */
  wrapWidth?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const areaById = useMemo(() => new Map(atlas.screens.map((s) => [s.id, s.area])), [atlas.screens]);
  const areaOf = useCallback((id: string) => areaById.get(id), [areaById]);
  const areaName = useMemo(() => new Map(atlas.areas.map((a) => [a.key, a.name])), [atlas.areas]);
  const shapes = useMemo(() => shapesOf(atlas), [atlas]);
  const capture = useMemo(() => capturing(atlas), [atlas]);
  const layout = useMemo(
    () => layoutRow(row.screens, platforms, atlas.flows, areaOf, shapes, wrapWidth),
    [row.screens, platforms, atlas.flows, areaOf, shapes, wrapWidth],
  );
  const lit = useMemo(() => {
    if (!hover) return null;
    const ids = new Set<string>([hover]);
    for (const a of layout.arrows) if (a.from === hover || a.to === hover) ids.add(a.from).add(a.to);
    return ids;
  }, [hover, layout.arrows]);
  const leaving = useMemo(() => {
    const seen = new Map<string, string>();
    for (const list of layout.out.values()) for (const o of list) if (!seen.has(o.area)) seen.set(o.area, o.label);
    return [...seen].map(([key, label]) => ({ key, label, name: areaName.get(key) ?? key }));
  }, [layout.out, areaName]);
  const differs = row.screens.filter((s) => s.similarity && LOOKS_DIFFERENT.includes(s.similarity.badge)).length;
  const missing = row.screens.filter((s) => s.similarity?.badge === "missing").length;
  const seen = row.screens.filter((s) => !s.never_seen).length;
  const headingId = `atlas-area-${row.area.key}`;
  return (
    <section
      className={cn(styles.row, "py-6")}
      // Skipped off screen at its real height (the heading, its row and the padding), so rows coming into view never shift the page.
      style={{ containIntrinsicSize: `auto ${layout.height + 104}px` }}
      aria-labelledby={headingId}
      data-atlas-area={row.area.key}
      // The first rows deal their cards in when the page opens; the rest are already there.
      data-enter={index < 2 || undefined}
    >
      <div className={cn(board.areaHead, "px-4 md:px-6")}>
        <span className={board.areaIndex} aria-hidden>
          {String(index + 1).padStart(2, "0")}
        </span>
        <h2 id={headingId} className={board.areaName}>
          <button type="button" className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onArea(row.area.key)} title={`Only ${row.area.name}`}>
            {row.area.name}
          </button>
        </h2>
        {areaSummary(row.area.summary) ? <span className="text-sm text-muted">{areaSummary(row.area.summary)}</span> : null}
        <SeenDots screens={row.screens} />
        <span className="text-xs text-muted" data-atlas-area-count>
          {areaCountWords(row.screens.length, row.area.screens.length, seen, differs, missing)}
        </span>
        {leaving.length ? <LeadsTo areas={leaving} onGo={onGoArea} /> : null}
      </div>
      <div className={cn(styles.strip, "px-4 pb-1 md:px-6")}>
        <div className={styles.lane} style={{ width: layout.width, height: layout.height }}>
          {arrows ? (
            <svg
              key={drawKey}
              className={styles.arrows}
              width={layout.width}
              height={layout.height}
              aria-hidden
              data-atlas-arrows
              data-draw={drawKey > 0 || undefined}
            >
              {drawKey > 0 ? (
                <defs>
                  {layout.arrows.map((a, k) => (
                    <mask key={k} id={`${uid}-draw-${k}`} maskUnits="userSpaceOnUse" x={-8} y={-8} width={layout.width + 16} height={layout.height + 16}>
                      <path d={a.d} pathLength={1} className={styles.drawMask} style={delay(k)} />
                    </mask>
                  ))}
                </defs>
              ) : null}
              {layout.arrows.map((a, k) => {
                const on = lit ? lit.has(a.from) && lit.has(a.to) && (a.from === hover || a.to === hover) : false;
                return (
                  <g
                    key={`${a.from}>${a.to}`}
                    className={styles.flow}
                    style={delay(k)}
                    data-seen={a.seen ? "true" : "false"}
                    data-lit={on || undefined}
                    data-dim={lit && !on ? "true" : undefined}
                    data-atlas-arrow={a.kind}
                  >
                    <path d={a.d} className={styles.arrow} mask={drawKey > 0 ? `url(#${uid}-draw-${k})` : undefined} />
                    <path d={a.head} className={styles.head} />
                    {on ? (
                      // A light running along a lit arrow, the way the move goes (only while hovered).
                      <circle r={3} className={styles.traveler}>
                        <animateMotion dur={a.kind === "next" ? "1.1s" : "1.8s"} repeatCount="indefinite" path={a.d} calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.4 0 0.2 1" />
                      </circle>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          ) : null}
          {arrows && hover
            ? layout.arrows
                .filter((a) => a.from === hover || a.to === hover)
                .map((a) => (
                  <span
                    key={`label:${a.from}>${a.to}`}
                    className={styles.moveLabel}
                    style={{ left: a.lx, top: a.kind === "next" ? a.ly - 30 : a.ly - 10 }}
                    data-atlas-move-label
                  >
                    {moveWords(a.label)}
                  </span>
                ))
            : null}
          {row.screens.map((s, i) => (
            <ScreenCard
              key={s.id}
              screen={s}
              platforms={platforms}
              shapes={shapes}
              x={layout.cards[i].x}
              y={layout.cards[i].y}
              width={layout.cards[i].w}
              height={layout.cardH}
              lit={Boolean(lit?.has(s.id))}
              dim={Boolean(lit && !lit.has(s.id))}
              fresh={fresh.has(s.id)}
              order={i}
              glowAt={glow?.get(s.id) ?? null}
              capturing={capture.get(s.id) ?? null}
              onOpen={onOpen}
              onHover={setHover}
              fillOn={fillOn}
              onFill={onFill}
            />
          ))}
        </div>
      </div>
    </section>
  );
});

/**
 * The storyboard: one row per area, in the order a person walks the app. A row's cards wrap onto
 * more lines at the board's width, so nothing hides off to the right and the page only scrolls
 * down. Rows off screen skip layout and paint (`content-visibility`), and frames load as they
 * scroll in, so 200 screens stay smooth.
 */
export function Storyboard({
  atlas,
  rows,
  platforms,
  arrows,
  drawKey = 0,
  fresh,
  glow = null,
  onOpen,
  onArea,
  fillOn,
  onFill,
}: {
  atlas: Atlas;
  rows: AreaRow[];
  platforms: Platform[];
  arrows: boolean;
  /** Bumped each time the arrows are turned on, so they draw in. */
  drawKey?: number;
  fresh: ReadonlySet<string>;
  /** Cards to light one after another, by their order. */
  glow?: ReadonlyMap<string, number> | null;
  onOpen: (id: string) => void;
  onArea: (key: string) => void;
  /** "Fill in Android" from a card's not-seen frame (on hover and focus). */
  fillOn?: ReadonlySet<Platform>;
  onFill?: (platform: Platform) => void;
}) {
  // To an area's row when it is on the page, else the atlas narrowed to that area.
  const onGoArea = useCallback(
    (key: string) => {
      const el = document.querySelector<HTMLElement>(`[data-atlas-area="${CSS.escape(key)}"]`);
      if (!el) return onArea(key);
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
      el.querySelector<HTMLElement>("h2 button")?.focus({ preventScroll: true });
    },
    [onArea],
  );
  const { ref: measureBoard, width: wrapWidth } = useWrapWidth();
  return (
    <div ref={measureBoard} className={styles.board} data-atlas-storyboard>
      {rows.map((row, i) => (
        <AreaStrip key={row.area.key} index={i} row={row} atlas={atlas} platforms={platforms} arrows={arrows} fresh={fresh} glow={glow} onOpen={onOpen} onArea={onArea} onGoArea={onGoArea} drawKey={drawKey} fillOn={fillOn} onFill={onFill} wrapWidth={wrapWidth} />
      ))}
    </div>
  );
}

/**
 * The width a row's cards wrap to: the board's, less the rows' side padding (`px-4 md:px-6`),
 * kept to 8 px steps so a resize re-lays the rows only when a card could move. Undefined until
 * measured (the first paint is one line, as before).
 */
function useWrapWidth(): { ref: (el: HTMLDivElement | null) => void; width: number | undefined } {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const pad = window.matchMedia("(min-width: 768px)").matches ? 24 : 16;
      const inner = Math.max(0, el.clientWidth - 2 * pad);
      setWidth((was) => (was !== undefined && Math.abs(was - inner) < 8 ? was : Math.floor(inner / 8) * 8));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, width };
}
