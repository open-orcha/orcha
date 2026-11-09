import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown, FileCode2, FileSearch, PenLine, Sparkles } from "../../map/kit/icons";
import { urlFor } from "../frames";
import { draftedTitles, stageTiles, tileWidth, type StageFrame } from "./lib/drafting-stage";
import type { RequestActivity } from "./lib/types";
import { cn, usePrefersReducedMotion } from "../../map/kit";
import { DRAFTING_STAGE_LABEL, draftingStage, readCounts, type DraftingStage as DraftingStageKey } from "../work/words";

const TILE_H = 148;
const GAP = 14;
/** How long a screenshot holds the focus before the strip glides to the next. */
const FOCUS_MS = 3400;

const STAGE_ICON: Record<DraftingStageKey, typeof Sparkles> = {
  queued: Sparkles,
  reading: FileSearch,
  drafting: PenLine,
  done: Sparkles,
  failed: Sparkles,
  stopped: Sparkles,
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Time since `since`, ticking while it runs; once it ended, up to its last update (`until`), so
 * a finished job reads its length, not the time since it started (it read "57m 37s" for a job
 * that took 13m 39s). */
function useElapsed(since: string | null, running: boolean, until?: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!since) return 0;
  const end = !running && until ? new Date(until).getTime() : now;
  return Math.max(0, end - new Date(since).getTime());
}

/** The note, revealed a few characters at a time; the whole text at once under reduced motion. */
function useTyped(text: string, enabled: boolean): string {
  const [typed, setTyped] = useState({ text, n: enabled ? 0 : text.length });
  // A new note restarts the reveal (state adjusted during render, not in an effect).
  if (typed.text !== text) setTyped({ text, n: enabled ? 0 : text.length });
  const pending = enabled && typed.text === text && typed.n < text.length;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setTyped((cur) => (cur.n >= cur.text.length ? cur : { ...cur, n: cur.n + 3 })), 16);
    return () => clearInterval(t);
  }, [pending, text]);
  return typed.text === text ? text.slice(0, enabled ? typed.n : text.length) : "";
}

/**
 * What Orcha is looking at while it drafts, as a stage rather than a log: the
 * screenshots of the explorations it learns from (or the files it reads, when it works
 * from code alone) glide through focus like a film strip, the focused one breathes, its
 * colours bleed into the backdrop, and each drafted scenario lands as a card in the corner.
 * The current action is typed above it; the activity log sits under the card (`WorkLog`).
 * Fed by what the drafter says (`qa_drafting.py`, `_activity`), read while it runs.
 */
export function DraftingStage({
  activity,
  status,
  drafted,
  frames,
  collapsible = false,
  autoCollapse = false,
  exploring = false,
  className,
}: {
  activity: RequestActivity | null;
  /** It walks the app first: the drafts come after. */
  exploring?: boolean;
  status: string | null;
  drafted: number;
  /** Screenshots of the explorations the drafter reads. */
  frames: readonly StageFrame[];
  /** The header row toggles the rest of the card (the side-by-side review). */
  collapsible?: boolean;
  /** `collapsible` only: fold to the one-line status until the person opens it (once there
   * are drafts to review, the drafts matter more than the animation). */
  autoCollapse?: boolean;
  className?: string;
}) {
  // null: follow `autoCollapse`; a boolean once the person toggled it.
  const [open, setOpen] = useState<boolean | null>(null);
  const collapsed = collapsible && !(open ?? !autoCollapse);
  const reduced = usePrefersReducedMotion();
  const running = status === "running" || status === "queued";
  const elapsed = useElapsed(activity?.started_at ?? null, running, activity?.updated_at ?? null);
  const phase = status === "queued" ? "queued" : (activity?.phase ?? "starting");
  // The stage never goes back: reading until the first draft lands, drafting after, even
  // when the agent's last call was a search between two drafts ("Mapping the repository" was
  // shown while drafts were landing). What it does this moment is the note beside it.
  const stage = draftingStage({ status, drafted });
  const Icon = STAGE_ICON[stage];
  const recentLines = activity?.recent;
  const recent = useMemo(() => recentLines ?? [], [recentLines]);
  const label = exploring ? "Exploring first" : DRAFTING_STAGE_LABEL[stage];
  const counters = readCounts(activity);
  const note = useTyped(activity?.note ?? "", !reduced && running);

  const tiles = useMemo(() => stageTiles(frames, recent), [frames, recent]);
  const titles = useMemo(() => draftedTitles(recent), [recent]);
  const fromFrames = tiles.length > 0 && tiles[0].type === "frame";

  // Screenshots take turns in focus; file tiles keep the newest read in focus.
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (!fromFrames || tiles.length < 2 || !running || reduced) return;
    const t = setInterval(() => setCursor((c) => c + 1), FOCUS_MS);
    return () => clearInterval(t);
  }, [fromFrames, tiles.length, running, reduced]);
  const focus = tiles.length === 0 ? 0 : fromFrames ? cursor % tiles.length : tiles.length - 1;

  // Tile centres, so the strip can be laid out around whichever tile is in focus.
  const widths = tiles.map((t) => tileWidth(t.kind, TILE_H));
  const centres: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    centres.push(i === 0 ? 0 : centres[i - 1] + (widths[i - 1] + widths[i]) / 2 + GAP);
  }
  const focused = tiles[focus];
  const ambient = focused && focused.type === "frame" ? urlFor(focused.path) : null;

  return (
    <section
      className={cn("relative overflow-hidden rounded-lg border border-border bg-panel", className)}
      aria-live="polite"
      data-drafting-stage
      data-phase={phase}
      data-stage={stage}
      data-stage-mode={tiles.length === 0 ? "empty" : fromFrames ? "frames" : "files"}
      data-stage-collapsed={collapsible ? String(collapsed) : undefined}
    >
      <div
        className={cn(
          "relative z-10 flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5",
          collapsible && "cursor-pointer select-none hover:bg-hover/40",
          collapsed && "flex-nowrap",
        )}
        {...(collapsible
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": !collapsed,
              "aria-label": collapsed ? `${label}: show what Embodent is reading` : `${label}: fold`,
              onClick: () => setOpen(collapsed),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen(collapsed);
                }
              },
            }
          : {})}
        data-stage-toggle={collapsible ? "" : undefined}
      >
        <span className="relative flex size-6 items-center justify-center rounded-md border border-border bg-panel-2 text-muted">
          <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
          {running ? <span className="absolute inset-0 animate-ping-slow rounded-md border border-primary/40" aria-hidden /> : null}
        </span>
        <span className="text-sm font-medium text-fg" data-activity-phase>
          {label}
        </span>
        {activity?.note ? (
          <span className="min-w-0 flex-1 truncate text-sm text-muted" data-activity-note>
            {note}
            {running && note.length < (activity.note?.length ?? 0) ? (
              <span className="animate-caret ml-0.5 inline-block h-3 w-[6px] align-middle bg-primary/80" aria-hidden />
            ) : null}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-3 font-mono text-xs tabular text-muted">
          {counters ? <span data-activity-reads>{counters}</span> : null}
          <span data-activity-drafted>{drafted} drafted</span>
          {activity?.started_at ? <span data-activity-elapsed>{fmtElapsed(elapsed)}</span> : null}
          {collapsible ? (
            <ChevronDown
              className={cn("size-3.5 transition-transform motion-reduce:transition-none", !collapsed && "rotate-180")}
              aria-hidden
            />
          ) : null}
        </span>
      </div>

      {collapsed ? null : tiles.length > 0 ? (
        <div className="relative" style={{ height: TILE_H + 24 }} data-stage-strip>
          {/* Ambient: the focused screenshot's colours, blurred, behind everything. */}
          <div className="absolute inset-0 overflow-hidden bg-panel-2" aria-hidden>
            {ambient ? (
                          <img
                key={ambient}
                src={ambient}
                alt=""
                className="absolute inset-0 size-full scale-125 object-cover opacity-40 blur-2xl saturate-150 animate-fade-in"
                draggable={false}
              />
            ) : null}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,var(--color-panel)_120%)]" />
          </div>

          {/* The strip: every tile is positioned from the centre by its distance to the focus. */}
          <div
            className="absolute inset-x-0 top-3 flex justify-center"
            style={{
              height: TILE_H,
              // The strip fades out at both edges instead of being cut.
              maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
              WebkitMaskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
            }}
          >
            {tiles.map((t, i) => {
              const d = i - focus;
              const ad = Math.abs(d);
              const w = widths[i];
              // The strip sits a little left once drafted cards occupy the corner.
              const x = centres[i] - centres[focus] - (titles.length > 0 ? 70 : 0);
              const scale = ad === 0 ? 1.06 : ad === 1 ? 0.94 : 0.88;
              const opacity = ad === 0 ? 1 : ad === 1 ? 0.72 : ad === 2 ? 0.42 : 0.18;
              const blur = ad >= 2 ? `blur(${ad >= 3 ? 2 : 1}px)` : "none";
              const url = t.type === "frame" ? urlFor(t.path) : null;
              return (
                <div
                  key={t.key}
                  className="qa-stage-tile absolute top-0 left-1/2"
                  style={{
                    width: w,
                    height: TILE_H,
                    transform: `translateX(calc(-50% + ${x}px)) scale(${scale})`,
                    opacity,
                    filter: blur,
                    zIndex: 10 - ad,
                  }}
                  data-stage-tile={t.type}
                  data-stage-focus={ad === 0 ? "true" : undefined}
                >
                  <div
                    className={cn(
                      "size-full overflow-hidden rounded-[10px] border shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)]",
                      t.type === "frame" ? "border-white/15 bg-black" : "border-border bg-panel/95 backdrop-blur",
                      // Keyed tiles mount once, so the entrance plays only for tiles that are new.
                      "qa-tile-in",
                    )}
                  >
                    {t.type === "frame" && url ? (
                                          <img
                        src={url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className={cn("size-full object-cover object-top", ad === 0 && running && "qa-kenburns")}
                      />
                    ) : (
                      <FileTile dir={t.dir ?? ""} name={t.name ?? t.path} active={ad === 0 && running} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {titles.length > 0 ? <DraftedStack titles={titles} count={drafted} /> : null}
        </div>
      ) : running ? (
        <p className="border-t border-border bg-panel-2 px-3.5 py-2 text-xs text-muted">
          {status === "queued"
            ? "An agent picks this up within a few seconds when one is online."
            : "The first drafts usually land within a few minutes."}
        </p>
      ) : null}

      {running ? (
        <span className="absolute inset-x-0 bottom-0 z-10 h-px overflow-hidden bg-border" aria-hidden>
          <span className="block h-full w-1/3 animate-sweep bg-primary" />
        </span>
      ) : null}
    </section>
  );
}

/** A file Orcha is reading, drawn as a small document. */
function FileTile({ dir, name, active }: { dir: string; name: string; active: boolean }) {
  const lines = [0.9, 0.6, 0.75, 0.45, 0.8, 0.55, 0.7];
  return (
    <div className="flex size-full flex-col gap-2 p-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <FileCode2 className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11px] font-medium text-fg" title={`${dir}/${name}`}>
          {name}
        </span>
      </div>
      {dir ? <span className="truncate font-mono text-[10px] text-muted">{dir}</span> : null}
      <div className="mt-1 flex flex-col gap-[5px]">
        {lines.map((w, i) => (
          <span
            key={i}
            className={cn("h-[5px] rounded-sm bg-fg/10", active && i === 2 && "animate-shimmer")}
            style={{ width: `${w * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** The drafted scenarios landing in the corner, newest on top. */
function DraftedStack({ titles, count }: { titles: readonly string[]; count: number }) {
  const shown = titles.slice(-3).reverse();
  return (
    <div className="absolute right-3 bottom-3 z-20 flex w-[min(46%,260px)] flex-col items-end gap-1" data-stage-drafted>
      <span className="rounded-full border border-border bg-panel/90 px-2 py-0.5 font-mono text-[10px] tabular text-muted backdrop-blur">
        {count} drafted
      </span>
      <div className="relative h-[52px] w-full">
        {shown.map((t, i) => (
          <div
            key={t}
            className={cn(
              "absolute inset-x-0 bottom-0 truncate rounded-md border border-border bg-panel/95 px-2.5 py-1.5 text-xs text-fg shadow-lg backdrop-blur",
              i === 0 && "qa-chip-land",
            )}
            style={{
              transform: `translateY(${-i * 7}px) scale(${1 - i * 0.05})`,
              opacity: 1 - i * 0.35,
              zIndex: 3 - i,
            }}
            title={t}
          >
            <PenLine className="mr-1.5 inline size-3 text-primary" strokeWidth={1.75} aria-hidden />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
