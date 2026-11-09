import { ArrowDownRight, Check, TriangleAlert, X } from "../map/kit/icons";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../map/kit";
import { PLATFORM_WORD, plural } from "./model";
import story from "./story.module.css";
import type { Atlas, AtlasRefresh, AtlasScreen, Platform } from "./types";

/** Where a running pass is, read from what it writes (`onboarding_map` orchestrate's notes). */
export type PassStage = "queued" | "device" | "capturing";

export const STAGES: { key: PassStage | "done"; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "device", label: "On a device" },
  { key: "capturing", label: "Capturing" },
  { key: "done", label: "Done" },
];

/**
 * The stage a pass is at: queued until a device takes it ("Queued: a high-level map of 6 main
 * areas", or nothing said yet), on a device while it waits for one, capturing once it maps the app
 * or a screenshot has landed. A note it does not know reads as capturing while it runs.
 */
export function passStage(r: Pick<AtlasRefresh, "state" | "note">, captured = 0): PassStage {
  const note = (r.note ?? "").trim();
  if (captured > 0 || /^mapping/i.test(note)) return "capturing";
  // Before the device shows the app: waiting for it, readying it, building or installing the app.
  if (/^(waiting for a device|getting the device ready|preparing the environment|building the app|installing the app|opening the app)/i.test(note)) return "device";
  if (!note || /^(queued|starting)/i.test(note) || r.state === "pending") return "queued";
  return "capturing";
}

/** The screens the pass aims at that have their screenshot on its platform now, in the atlas's order. */
export function capturedShots(atlas: Atlas): { screen: AtlasScreen; platform: Platform; src: string }[] {
  const r = atlas.refresh;
  const aimed = new Set([...r.targets, ...(r.shots ?? [])]);
  if (!aimed.size) return [];
  const out: { screen: AtlasScreen; platform: Platform; src: string }[] = [];
  for (const s of atlas.screens) {
    if (!s.nodes.some((n) => aimed.has(n)) && !aimed.has(s.id)) continue;
    const p = r.platform ?? s.platforms[0];
    const src = p ? s.variants[p]?.frame_url : null;
    if (p && src) out.push({ screen: s, platform: p, src });
  }
  return out;
}

/** A camera's aperture: its blades turn while the pass runs (decorative; the words say it). */
function Aperture({ spinning }: { spinning: boolean }) {
  return (
    <span className={story.aperture} data-spinning={spinning || undefined} aria-hidden>
      <svg viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="17" className={story.apertureRim} />
        <g className={story.blades}>
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <path key={a} d="M20 20 L20 5 A15 15 0 0 1 32.99 12.5 Z" transform={`rotate(${a} 20 20)`} className={story.blade} />
          ))}
        </g>
        <circle cx="20" cy="20" r="6" className={story.apertureEye} />
      </svg>
    </span>
  );
}

/**
 * The high-level pass filling the atlas in, as a story told from what it writes: a rail of its
 * stages (queued, on a device, capturing, done) lit as it reaches each, what it is doing in its
 * own words, how many of the main areas it aims at have a screenshot now (a bar that grows), and a strip of the screenshots it has taken so far, each developing in as it
 * lands; one opens its card on the storyboard. Everything here is read from the atlas: no step is
 * lit before the pass says it got there.
 */
export function RefreshStory({
  atlas,
  refresh,
  seen,
  total,
  progress,
  onJump,
  children,
}: {
  atlas?: Atlas | null;
  refresh: AtlasRefresh;
  seen: number;
  total: number;
  progress?: { seen: number; total: number };
  onJump?: (id: string) => void;
  children?: ReactNode;
}) {
  const shots = atlas ? capturedShots(atlas) : [];
  const stage = passStage(refresh, progress?.seen ?? 0);
  const at = STAGES.findIndex((s) => s.key === stage);
  const share = progress && progress.total ? progress.seen / progress.total : null;
  // A fill-in (a deeper pass at one platform's unseen screens) says so; the refresh maps main areas.
  const fill = refresh.depth === "deeper";
  const what = fill ? "screens not seen yet" : "main areas";
  const words =
    stage === "capturing"
      ? refresh.note && !/^mapping/i.test(refresh.note) ? refresh.note : `Capturing the ${what}`
      : stage === "device"
        ? (refresh.note ?? "Waiting for a device")
        : (refresh.note ?? (fill ? "Queued: a pass at the screens not seen yet" : "Queued: a high-level map of the main areas"));
  return (
    <div className={story.band} role="status" aria-live="polite" data-atlas-filling data-stage={stage}>
      <Aperture spinning />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold text-fg">{fill && refresh.platform ? `Filling in ${PLATFORM_WORD[refresh.platform]}` : "Refreshing the atlas"}</span>
          <span className="text-sm text-fg-2" data-atlas-filling-note>
            {words}
          </span>
        </div>
        <ol className={story.rail} aria-label="How far the refresh is">
          {STAGES.map((s, i) => (
            <li key={s.key} className={story.stage} data-state={i < at ? "done" : i === at ? "now" : "next"} aria-current={i === at ? "step" : undefined}>
              <span className={story.stageMark} aria-hidden>
                {i < at ? <Check className="size-2.5" strokeWidth={3} /> : null}
              </span>
              <span className={story.stageWord}>{s.label}</span>
              {i < STAGES.length - 1 ? <span className={story.stageLine} aria-hidden /> : null}
            </li>
          ))}
        </ol>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {share !== null ? (
            <div className={story.progress} aria-hidden>
              <div className={story.progressFill} style={{ transform: `scaleX(${Math.max(0.02, share)})` }} />
            </div>
          ) : null}
          <span className="text-xs tabular-nums text-fg-2" data-atlas-filling-count>
            {progress && progress.total ? `${progress.seen} of ${progress.total} ${fill ? "screens" : "main areas"} captured` : `${seen} of ${total} screens seen`}
          </span>
          {children}
        </div>
      </div>
      {shots.length ? (
        <div className={story.shots} aria-label="Captured so far">
          {shots.slice(-6).map((s, i) => (
            <button
              key={s.screen.id}
              type="button"
              className={story.shot}
              style={{ "--i": i } as CSSProperties}
              onClick={() => onJump?.(s.screen.id)}
              title={`${s.screen.name} on ${PLATFORM_WORD[s.platform]}`}
              aria-label={`Show ${s.screen.name} on the storyboard`}
              data-atlas-filling-shot={s.screen.id}
            >
              <img src={s.src} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** How a pass ended, kept by the board when it saw the pass run. */
export interface Landing {
  state: "done" | "failed" | "skipped";
  note: string | null;
  /** Screens that got a new screenshot while the pass ran, in storyboard order. */
  gained: string[];
}

/**
 * The moment a pass the page watched ends: a check that draws itself, what the pass said it saw,
 * how many screens got a new screenshot while it ran, and "Show them", which lights
 * those cards one after another. A pass that failed or was stopped says so plainly instead.
 */
export function RefreshLanded({ landing, names, onShow, onClose }: { landing: Landing; names: Map<string, string>; onShow: () => void; onClose: () => void }) {
  const ok = landing.state === "done";
  const gained = landing.gained.length;
  return (
    <div className={cn(story.band, story.landed)} role="status" aria-live="polite" data-atlas-landed={landing.state}>
      <span className={cn(story.landMark, !ok && story.landMarkWarn)} aria-hidden>
        {ok ? (
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10.5" className={story.landRing} pathLength={1} />
            <path d="M7 12.5 L10.5 16 L17 8.5" className={story.landTick} pathLength={1} />
          </svg>
        ) : (
          <TriangleAlert className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">{ok ? "The atlas is refreshed" : landing.state === "failed" ? "The refresh stopped" : "The refresh was stopped"}</p>
        <p className="text-sm text-fg-2">
          {[
            landing.note,
            ok ? (gained ? `${plural(gained, "screen")} got a new screenshot` : "No screen got a new screenshot") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {ok && gained ? (
          <p className="mt-0.5 truncate text-xs text-muted">
            {landing.gained
              .slice(0, 4)
              .map((id) => names.get(id) ?? id)
              .join(", ")}
            {gained > 4 ? ` and ${gained - 4} more` : ""}
          </p>
        ) : null}
      </div>
      {ok && gained ? (
        <button type="button" className={story.landShow} onClick={onShow} data-atlas-landed-show>
          <ArrowDownRight className="size-3.5" aria-hidden /> Show {gained === 1 ? "it" : "them"}
        </button>
      ) : null}
      <button type="button" className={story.landClose} onClick={onClose} aria-label="Dismiss" data-atlas-landed-close>
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Each screen's screenshots as one string, to tell which ones a pass gave a new picture. */
export function frameSigs(atlas: Atlas): Map<string, string> {
  return new Map(atlas.screens.map((s) => [s.id, Object.values(s.variants).map((v) => v?.frame_url ?? "").join("|")]));
}

/** The pass the board watched has ended: how, and which screens got a new screenshot meanwhile. */
export function landingOf(atlas: Atlas, before: Map<string, string>): Landing | null {
  const r = atlas.refresh;
  if (r.state !== "done" && r.state !== "failed" && r.state !== "skipped") return null;
  const now = frameSigs(atlas);
  const gained = atlas.screens.filter((s) => now.get(s.id) !== before.get(s.id) && Object.values(s.variants).some((v) => v?.frame_url)).map((s) => s.id);
  return { state: r.state, note: r.note, gained };
}
