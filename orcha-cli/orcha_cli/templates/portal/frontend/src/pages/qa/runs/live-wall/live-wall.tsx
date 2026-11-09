import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "../../map/kit/icons";
import { useNow } from "../lib/use-now";
import { EXPANDED_CLASS } from "../lib/fullscreen";
import { useFullscreen } from "../lib/use-fullscreen";
import { moveFocus, wallCounts, wallLayout, type ShownTile } from "../lib/live-wall";
import type { TargetKind } from "../types";
import { Button, PLATFORM_LABELS, usePathname, useSearchParams } from "../../map/kit";
import { cn } from "../../map/kit";
import { useLiveWall } from "./use-live-wall";
import { WallTile } from "./wall-tile";
import motion from "./live-wall.module.css";

const NARROW_PX = 640;
const WIDE_PX = 1600;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The stage's width, for the layout (2 columns on a phone, 4 on a very wide screen). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number | null] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const sortKinds = (kinds: ReadonlySet<TargetKind>): TargetKind[] => (["ios", "android", "web", "desktop"] as const).filter((k) => kinds.has(k));

function chipClass(on: boolean): string {
  return cn(
    "flex h-6 items-center rounded-full px-2.5 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--wall-accent)]",
    on ? "bg-[var(--wall-chip-on)] text-[var(--wall-fg)]" : "text-[var(--wall-fg-2)] hover:bg-[var(--wall-chip-hover)] hover:text-[var(--wall-fg)]",
  );
}

/**
 * The live wall (`/runs/live`): every running run's screen at once on a stage in the app's theme, laid out by
 * how many there are (1 large, 2 side by side, 2x2, 3x2, 3x3, then rows that scroll); queued
 * runs wait quietly at the end. One batched poll feeds every tile (`useLiveWall`). Clicking a
 * tile opens that run's live page. The arrows move between tiles, Enter opens one, F enlarges
 * the focused tile over a filmstrip of the others and Escape leaves that.
 */
export function LiveWall({ cid, onNewRun, newRunReason }: { cid: string; onNewRun: () => void; newRunReason: string | null }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { tiles: all, loaded } = useLiveWall({ cid, platform: null, pathname, search });
  const [platform, setPlatform] = useState<TargetKind | null>(null);
  const tiles = useMemo(() => all.filter((t) => !platform || t.kind === platform), [all, platform]);
  const kinds = useMemo(() => sortKinds(new Set(all.map((t) => t.kind))), [all]);
  const live = tiles.filter((t) => t.endedAt == null);
  const now = useNow(tiles.length > 0, 1000);
  const [stageRef, width] = useWidth<HTMLDivElement>();
  const narrow = width != null && width < NARROW_PX;
  const layout = wallLayout(tiles.length, { narrow, wide: width != null && width >= WIDE_PX });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const tileRefs = useRef(new Map<string, HTMLAnchorElement>());
  // Tiles present on the first answer appear at once; later ones rise in.
  const [firstKeys, setFirstKeys] = useState<Set<string> | null>(null);
  if (loaded && firstKeys == null) setFirstKeys(new Set(all.map((t) => t.key)));
  const [reduced] = useState(prefersReducedMotion);

  const focusIndex = Math.max(0, tiles.findIndex((t) => t.key === focusKey));
  const focused: ShownTile | null = tiles[focusIndex] ?? null;
  const inFocusMode = focusMode && focused != null && tiles.length > 1;

  const focusTile = useCallback((key: string) => {
    setFocusKey(key);
    tileRefs.current.get(key)?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']") || t.isContentEditable)) return;
      if (tiles.length === 0) return;
      if (e.key === "Escape" && focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (!focusKey && focused) setFocusKey(focused.key);
        setFocusMode((m) => !m);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      // In focus mode the filmstrip is one column (or one row on a phone): every arrow steps.
      const cols = inFocusMode ? 1 : layout.cols;
      const next = tiles[moveFocus(focusIndex, e.key, cols, tiles.length)];
      if (next) focusTile(next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tiles, focusIndex, focusKey, focused, focusMode, inFocusMode, layout.cols, focusTile]);

  // The browser's full screen when allowed; otherwise (or refused) the wall fills the window.
  const fullscreen = useFullscreen(stageRef);

  const renderTile = (t: ShownTile, compact = false) => (
    <WallTile
      key={t.key}
      ref={(el) => {
        if (el) tileRefs.current.set(t.key, el);
        else tileRefs.current.delete(t.key);
      }}
      tile={t}
      now={now}
      focused={focused?.key === t.key}
      compact={compact}
      animateIn={!reduced && firstKeys != null && !firstKeys.has(t.key)}
      onFocus={() => setFocusKey(t.key)}
    />
  );

  return (
    <div
      ref={stageRef}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", motion.stage, fullscreen.expanded && EXPANDED_CLASS)}
      data-fullscreen={fullscreen.mode}
      data-live-wall
      data-wall-layout={`${layout.cols}x${layout.rows}`}
    >
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-1 pt-3 max-[720px]:px-4">
        <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--wall-fg)]" data-wall-counts>
          {live.length > 0 ? <span aria-hidden className="v-live size-1.5 text-[#ff5d52]" /> : null}
          {loaded ? (live.length > 0 ? wallCounts(live) : "Nothing running") : "Connecting…"}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1" data-wall-filters>
          {kinds.length > 1 || platform ? (
            <>
              <button type="button" className={chipClass(platform == null)} aria-pressed={platform == null} onClick={() => setPlatform(null)} data-wall-platform="all">
                All platforms
              </button>
              {sortKinds(new Set([...kinds, ...(platform ? [platform] : [])])).map((k) => (
                <button key={k} type="button" className={chipClass(platform === k)} aria-pressed={platform === k} onClick={() => setPlatform(platform === k ? null : k)} data-wall-platform={k}>
                  {PLATFORM_LABELS[k]}
                </button>
              ))}
            </>
          ) : null}
          {tiles.length > 1 ? (
            <button
              type="button"
              className={chipClass(focusMode)}
              aria-pressed={focusMode}
              onClick={() => {
                if (!focusKey && focused) setFocusKey(focused.key);
                setFocusMode((m) => !m);
              }}
              title="Enlarge the focused run (F)"
              data-wall-focus-toggle
            >
              Focus <kbd className="ml-1.5 font-mono text-[10px] text-[var(--wall-fg-4)]">F</kbd>
            </button>
          ) : null}
          <button
            type="button"
            className={cn(chipClass(false), "px-1.5")}
            onClick={fullscreen.toggle}
            aria-label={fullscreen.label}
            title={fullscreen.label}
            aria-pressed={fullscreen.active}
            data-wall-fullscreen
          >
            {fullscreen.active ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </span>
      </div>

      {loaded && tiles.length === 0 ? (
        <WallEmpty filtered={Boolean(platform)} onNewRun={onNewRun} newRunReason={newRunReason} />
      ) : inFocusMode && focused ? (
        <div
          className={cn("flex min-h-0 flex-1 gap-3 px-4 pb-4 pt-2", narrow ? "flex-col" : "flex-row")}
          data-wall-focus-mode={focused.key}
        >
          <div className="flex min-h-0 min-w-0 flex-1">{renderTile(focused)}</div>
          <div
            className={cn("flex shrink-0 gap-2 overflow-auto", narrow ? "h-[132px] flex-row" : "w-[168px] flex-col")}
            data-wall-filmstrip
          >
            {tiles
              .filter((t) => t.key !== focused.key)
              .map((t) => (
                <div key={t.key} className={cn("flex shrink-0", narrow ? "h-full w-[96px]" : "h-[150px] w-full")}>
                  {renderTile(t, true)}
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div
          role="list"
          aria-label="Running runs"
          className={cn("grid min-h-0 flex-1 gap-3 px-4 pb-4 pt-2", layout.scroll ? "overflow-y-auto" : "overflow-hidden")}
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
            ...(layout.scroll
              ? { gridAutoRows: narrow ? "300px" : "minmax(280px, calc((100% - 1.5rem) / 3))" }
              : { gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }),
          }}
          data-wall-grid
        >
          {loaded
            ? tiles.map((t) => (
                <div key={t.key} role="listitem" className="flex min-h-0 min-w-0">
                  {renderTile(t)}
                </div>
              ))
            : null}
        </div>
      )}
    </div>
  );
}

/** Nothing running: a calm row of ghost devices a light passes through, and how to fill it. */
function WallEmpty({ filtered, onNewRun, newRunReason }: { filtered: boolean; onNewRun: () => void; newRunReason: string | null }) {
  const ghosts = [
    { shape: "aspect-[9/19.5] w-[72px] rounded-[16px]", delay: "0s" },
    { shape: "aspect-[3/4] w-[132px] rounded-[10px]", delay: "1.2s" },
    { shape: "aspect-[16/10] w-[176px] rounded-md", delay: "2.4s" },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 px-6 pb-10 text-center" data-wall-empty>
      <div aria-hidden className="flex items-end gap-5 max-[480px]:scale-[0.8]">
        {ghosts.map((g) => (
          <div key={g.delay} className="flex flex-col items-center gap-2">
            <div className={cn(motion.ghost, g.shape)} style={{ ["--ghost-delay" as string]: g.delay }} />
            <span className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full bg-[var(--wall-accent)]", motion.ghostDot)} style={{ ["--ghost-delay" as string]: g.delay }} />
              <span className="h-1 w-10 rounded-full bg-[var(--wall-line)]" />
            </span>
          </div>
        ))}
      </div>
      <div className="flex max-w-sm flex-col items-center gap-2">
        <h2 className="text-[15px] font-semibold text-[var(--wall-fg)]">Nothing is running</h2>
        <p className="text-sm leading-5 text-[var(--wall-fg-2)]">
          {filtered ? "Nothing matches this filter right now." : "Start QA on your devices to watch them all here."}
        </p>
      </div>
      <Button size="sm" variant="primary" disabled={newRunReason != null} title={newRunReason ?? undefined} onClick={onNewRun} data-wall-new-run>
        Run check
      </Button>
    </div>
  );
}
