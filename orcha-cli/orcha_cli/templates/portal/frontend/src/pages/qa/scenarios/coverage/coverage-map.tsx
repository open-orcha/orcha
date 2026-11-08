
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { useDarkTheme, usePrefersReducedMotion } from "../../map/kit";
import { fogStyle, paintFog, type FogRect } from "../../map/fog-paint";
import { layoutMap, mapHeight, type LayoutTile } from "./map-layout";
import { plural, stateOn } from "./panel-model";
import styles from "../../map/coverage.module.css";
import { PLATFORM_LABEL, STATE_LABEL, type CoverageArea, type CoverageState, type PlatformKey } from "./types";

/** How thick the fog stays over a tile once it has lifted: thick over the untested, thinner
 * over what an exploration saw, gone elsewhere. */
function fogFor(state: CoverageState, seen: boolean): number {
  if (state !== "untested") return 0;
  return seen ? 0.55 : 1;
}

/** The painted fog for this layout: `fog` at each tile's level, `veil` thick over every tile
 * (the arrival state that dissolves). Repainted when the layout, platform or theme changes; the
 * old blob URLs are revoked. */
function useFogImages(
  box: RefObject<HTMLElement>,
  layout: { width: number; height: number; tiles: readonly LayoutTile[] } | null,
  levels: ReadonlyMap<string, number>,
  dark: boolean,
  narrow: boolean,
): { fog: string | null; veil: string | null } {
  const [images, setImages] = useState<{ fog: string | null; veil: string | null }>({ fog: null, veil: null });
  const key = layout ? layout.tiles.map((t) => `${t.key}:${t.x},${t.y},${t.w},${t.h}:${levels.get(t.key) ?? 0}`).join("|") : "";
  useEffect(() => {
    if (!layout || !box.current) return;
    let alive = true;
    const urls: string[] = [];
    const color = getComputedStyle(box.current).getPropertyValue("--cov-fog").trim() || (dark ? "#6f7a93" : "#b9bdc8");
    const style = fogStyle(dark, color, narrow);
    const rects = (all: boolean): FogRect[] => layout.tiles.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h, fog: all ? 1 : (levels.get(t.key) ?? 0) }));
    void Promise.all([paintFog(rects(false), layout.width, layout.height, style), paintFog(rects(true), layout.width, layout.height, style)]).then(([fog, veil]) => {
      for (const u of [fog, veil]) if (u) urls.push(u);
      if (alive) setImages({ fog, veil });
      else urls.forEach((u) => URL.revokeObjectURL(u));
    });
    return () => {
      alive = false;
      // Revoked after the next paint has replaced them, so the map never flashes clear.
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1500);
    };
    // `key` stands for layout + levels; `box` is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dark, narrow]);
  return images;
}

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The observer also reports the first size as soon as it starts observing.
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** `name` cut to fit `px` at ~6.6px a character. */
function fit(name: string, px: number, charPx = 6.6): string {
  const max = Math.floor(px / charPx);
  if (max < 3) return "";
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * The fog-of-war map: every feature area a tile in its code group's territory, sized by
 * importance and lit by its coverage state on the chosen platform. Fog covers the whole map
 * on arrival and lifts tile by tile; it stays over areas no scenario tests (thinner where an
 * exploration has been). Areas run in the last day glow. Hover names a tile; click opens it.
 */
export function CoverageMap({
  areas,
  platform,
  selected,
  onSelect,
  reveal,
  fogAll = false,
  startLifted = false,
}: {
  areas: readonly CoverageArea[];
  platform: PlatformKey;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Bump to replay the fog lifting (after Recompute). */
  reveal: number;
  /** Keep every tile under fog (no scenarios yet). */
  fogAll?: boolean;
  /** Skip the arrival fog (back from the List view: the map was already revealed). */
  startLifted?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();
  const dark = useDarkTheme();
  // The reveal the fog has lifted for: a new `reveal` (Recompute) brings the fog back down.
  const [liftedFor, setLiftedFor] = useState<number | null>(startLifted ? reveal : null);
  const lifted = liftedFor === reveal;
  const [hover, setHover] = useState<string | null>(null);
  const height = width ? mapHeight(width, areas.length) : 0;
  const narrow = width > 0 && width < 640;

  const byKey = useMemo(() => new Map(areas.map((a) => [a.key, a])), [areas]);
  const levels = useMemo(
    () => new Map(areas.map((a) => [a.key, fogAll ? 1 : fogFor(stateOn(a, platform), a.seen)])),
    [areas, platform, fogAll],
  );
  const layout = useMemo(
    () => (width ? layoutMap(areas, width, height, { gap: narrow ? 5 : 7, header: narrow ? 20 : 24 }) : null),
    [areas, width, height, narrow],
  );
  const { fog, veil } = useFogImages(boxRef, layout, levels, dark, narrow);

  // Fog down on arrival and on every Recompute, then lift a couple of frames after it is painted.
  const measured = width > 0 && veil !== null;
  useEffect(() => {
    if (!measured) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setLiftedFor(reveal));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [reveal, measured]);

  // The fog lifts in a sweep from the top left, faster for big maps.
  const order = useMemo(() => {
    if (!layout) return new Map<string, number>();
    const sorted = [...layout.tiles].sort((a, b) => a.x + a.y * 0.6 - (b.x + b.y * 0.6));
    const step = Math.max(14, Math.min(70, 1600 / Math.max(1, sorted.length)));
    return new Map(sorted.map((t, i) => [t.key, 250 + i * step]));
  }, [layout]);

  const hovered = hover ? byKey.get(hover) : undefined;
  const hoveredTile = hover && layout ? layout.tiles.find((t) => t.key === hover) : undefined;

  function keyDown(e: KeyboardEvent, key: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(key);
    }
  }

  const veiled = !lifted && !reduced;

  return (
    <div className={styles.stage} data-coverage-map data-platform={platform} data-lifted={lifted || reduced ? "true" : "false"}>
      <div ref={boxRef} className="relative w-full" style={{ minHeight: height || 380 }}>
        {layout ? (
          <svg key={dark ? "dark" : "light"} className={styles.svg} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Coverage map">
            <defs>
              <pattern id={`${uid}grid`} width="22" height="22" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.9" fill="var(--cov-grid)" />
              </pattern>
              <linearGradient id={`${uid}sheen`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--cov-glint)" />
                <stop offset="0.55" stopColor="var(--cov-glint)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`${uid}sweep`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0" />
                <stop offset="0.5" stopColor="var(--color-primary)" stopOpacity="0.16" />
                <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
              </linearGradient>
              {(["strong", "covered", "thin", "failing"] as const).map((s) => (
                <radialGradient key={s} id={`${uid}light-${s}`} cx="0.15" cy="0" r="1.1">
                  <stop offset="0" stopColor={`var(--cov-${s})`} stopOpacity="0.34" />
                  <stop offset="0.6" stopColor={`var(--cov-${s})`} stopOpacity="0.06" />
                  <stop offset="1" stopColor={`var(--cov-${s})`} stopOpacity="0" />
                </radialGradient>
              ))}
              <filter id={`${uid}glow`} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="5" />
              </filter>
            </defs>

            <rect width={layout.width} height={layout.height} fill={`url(#${uid}grid)`} />

            {layout.groups.length > 1
              ? layout.groups.map((g) => (
                  <g key={g.key} data-coverage-group={g.key}>
                    <rect className={styles.territory} x={g.x} y={g.y} width={g.w} height={g.h} rx="12" />
                    {g.h > 60 && g.w > 72 ? (
                      <text className={styles.territoryLabel} x={g.x + 10} y={g.y + 15}>
                        {fit(g.label.toUpperCase(), g.w - 20, 8)}
                      </text>
                    ) : null}
                  </g>
                ))
              : null}

            {layout.tiles.map((t) => (
              <Tile
                key={t.key}
                tile={t}
                area={byKey.get(t.key)!}
                state={stateOn(byKey.get(t.key)!, platform)}
                selected={selected === t.key}
                uid={uid}
                onSelect={onSelect}
                onHover={setHover}
                onKeyDown={keyDown}
              />
            ))}

            {/* Fog: painted once into a bitmap (fog-paint.ts), never re-rendered per frame. The
                final fog sits under a veil of thick fog that dissolves on arrival. Until the
                paint lands, a flat haze keeps the tiles covered. */}
            <g className={styles.fog} aria-hidden data-coverage-fog>
              {fog ? (
                <image href={fog} x="0" y="0" width={layout.width} height={layout.height} preserveAspectRatio="none" />
              ) : (
                <rect width={layout.width} height={layout.height} className={styles.fogHaze} />
              )}
              {veil && !reduced ? (
                <image href={veil} x="0" y="0" width={layout.width} height={layout.height} preserveAspectRatio="none" className={styles.veil} data-veiled={veiled ? "true" : "false"} />
              ) : null}
            </g>

            {/* Labels sit above the fog, so an untested area still says what it is. */}
            {layout.tiles.map((t) => (
              <TileLabel
                key={t.key}
                tile={t}
                area={byKey.get(t.key)!}
                state={stateOn(byKey.get(t.key)!, platform)}
                veiled={veiled}
                delay={order.get(t.key) ?? 0}
              />
            ))}

            {lifted && !reduced
              ? layout.tiles.map((t) => {
                  const a = byKey.get(t.key)!;
                  return a.recent && !fogAll ? (
                    <g key={`glow-${t.key}`} className={styles.tile} data-state={stateOn(a, platform)} aria-hidden>
                      <rect className={styles.glow} x={t.x} y={t.y} width={t.w} height={t.h} rx="8" data-coverage-glow />
                    </g>
                  ) : null;
                })
              : null}

            {lifted && !reduced ? (
              <rect key={`sweep-${platform}-${reveal}`} className={styles.sweep} x="0" y="0" width={layout.width * 0.35} height={layout.height} fill={`url(#${uid}sweep)`} />
            ) : null}
          </svg>
        ) : null}

        {hovered && hoveredTile ? (
          <div className={styles.tooltip} style={{ left: hoveredTile.x + hoveredTile.w / 2, top: Math.max(56, hoveredTile.y + 6) }} data-coverage-tooltip>
            <div className="truncate text-sm font-medium text-fg">{hovered.name}</div>
            <div className="mt-0.5 text-xs text-fg-2">
              {hovered.seen && stateOn(hovered, platform) === "untested" ? "Seen, not tested" : STATE_LABEL[stateOn(hovered, platform)]}
              {platform !== "all" ? ` on ${PLATFORM_LABEL[platform] ?? platform}` : ""}
            </div>
            <div className="mt-1 text-xs text-muted">
              {plural((hovered.depths[platform] ?? hovered.depth).scenarios, "scenario")}
              {hovered.suggestions > 0 ? ` · ${plural(hovered.suggestions, "suggestion")}` : ""}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Tile({
  tile: t,
  area,
  state,
  selected,
  uid,
  onSelect,
  onHover,
  onKeyDown,
}: {
  tile: LayoutTile;
  area: CoverageArea;
  state: CoverageState;
  selected: boolean;
  uid: string;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  onKeyDown: (e: KeyboardEvent, key: string) => void;
}) {
  const label = `${area.name}: ${area.seen && state === "untested" ? "seen, not tested" : STATE_LABEL[state].toLowerCase()}, ${plural(area.linked, "scenario")}`;
  const depth = Math.min(1, area.depth.score / 10);
  return (
    <g
      className={styles.tile}
      data-coverage-area={area.key}
      data-state={state}
      data-seen={area.seen ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-recent={area.recent ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelect(area.key)}
      onKeyDown={(e) => onKeyDown(e, area.key)}
      onMouseEnter={() => onHover(area.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(area.key)}
      onBlur={() => onHover(null)}
    >
      {/* The halo (a blurred outline) only exists where the CSS shows it: a filter on all 31
          tiles, even invisible, cost WebKit a re-render on every change. */}
      {state === "strong" || state === "failing" ? (
        <rect className={styles.halo} x={t.x - 1.5} y={t.y - 1.5} width={t.w + 3} height={t.h + 3} rx="9" filter={`url(#${uid}glow)`} />
      ) : null}
      <rect className={styles.body} x={t.x} y={t.y} width={t.w} height={t.h} rx="8" />
      {state !== "untested" ? <rect className={styles.light} x={t.x} y={t.y} width={t.w} height={t.h} rx="8" fill={`url(#${uid}light-${state})`} /> : null}
      <rect className={styles.sheen} x={t.x + 1} y={t.y + 1} width={Math.max(0, t.w - 2)} height={Math.max(0, t.h / 2)} rx="7" fill={`url(#${uid}sheen)`} />
      {/* Depth as a thin bar along the bottom edge. */}
      {t.w > 40 && t.h > 30 ? <rect className={styles.bar} x={t.x + 8} y={t.y + t.h - 5} width={Math.max(0, (t.w - 16) * Math.max(0.04, depth))} height="2" rx="1" /> : null}
    </g>
  );
}

function TileLabel({ tile: t, area, state, veiled, delay }: { tile: LayoutTile; area: CoverageArea; state: CoverageState; veiled: boolean; delay: number }) {
  if (t.w < 46 || t.h < 26) return null;
  const name = fit(area.name, t.w - 18);
  if (!name) return null;
  const showMeta = t.h >= 50 && t.w >= 84;
  const metaState = area.seen && state === "untested" ? "Seen" : state === "failing" ? "Failing" : STATE_LABEL[state];
  const count = area.depth.scenarios;
  return (
    <g
      className={`${styles.tile} ${styles.labels}`}
      data-state={state}
      data-veiled={veiled ? "true" : "false"}
      style={{ "--delay": veiled ? "0ms" : `${delay + 200}ms` } as CSSProperties}
      aria-hidden
      pointerEvents="none"
    >
      <text className={styles.name} x={t.x + 10} y={t.y + (showMeta ? 21 : t.h / 2 + 4)}>
        {name}
      </text>
      {showMeta ? (
        <text className={styles.meta} x={t.x + 10} y={t.y + 37}>
          <tspan className={styles.metaState}>{fit(metaState, t.w - 20)}</tspan>
          {t.w > 150 && count > 0 ? <tspan>{` · ${plural(count, "scenario")}`}</tspan> : null}
          {t.w > 150 && count === 0 && area.suggestions > 0 ? <tspan>{` · ${plural(area.suggestions, "suggestion")}`}</tspan> : null}
        </text>
      ) : null}
    </g>
  );
}
