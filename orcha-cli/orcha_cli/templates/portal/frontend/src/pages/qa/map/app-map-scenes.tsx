import { Check, FileCode2, FlaskConical, History, Map as MapIcon, Radio, X } from "./kit/icons";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import cov from "./coverage.module.css";
import { cn, fmtRelative } from "./kit";
import styles from "./app-map.module.css";
import { RunAction } from "./map-actions";
import type { AppMapBuild, EvidenceSource } from "./types";

const d = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

/** The sketch's geometry: three features of a home-rentals app, their screens, the navigation
 * between them, one test's flow and the screens runs have seen. */
const REGIONS = [
  { key: "listings", label: "Listings", x: 16, y: 18, w: 238, h: 130 },
  { key: "viewings", label: "Viewings", x: 270, y: 18, w: 234, h: 130 },
  { key: "account", label: "Account", x: 16, y: 166, w: 488, h: 118 },
];
const SCREENS = [
  { id: "l1", x: 36, y: 50 },
  { id: "l2", x: 110, y: 50 },
  { id: "l3", x: 184, y: 50 },
  { id: "v1", x: 290, y: 50 },
  { id: "v2", x: 364, y: 50 },
  { id: "v3", x: 438, y: 50 },
  { id: "a1", x: 60, y: 198 },
  { id: "a2", x: 172, y: 198 },
  { id: "a3", x: 284, y: 198 },
  { id: "a4", x: 396, y: 198 },
];
const SW = 50;
const SH = 64;
const LINKS: [string, string][] = [
  ["l1", "l2"],
  ["l2", "l3"],
  ["l3", "v1"],
  ["v1", "v2"],
  ["v2", "v3"],
  ["a1", "a2"],
  ["a2", "a3"],
  ["a3", "a4"],
];
/** The test's flow: sign in, a listing, book a viewing. */
const FLOW = ["a1", "l1", "l2", "v1", "v2"];
/** Screens a run has seen, in the order their frames land. */
const SEEN = ["a1", "l1", "l2", "v1", "l3", "a2"];

const byId = new Map(SCREENS.map((s) => [s.id, s]));
const mid = (id: string) => {
  const s = byId.get(id)!;
  return { x: s.x + SW / 2, y: s.y + SH / 2 };
};

type Stage = "idle" | "code" | "tests" | "live" | "done";

/**
 * The map in miniature, drawn the way the builder fills it: code draws the regions, screens and
 * links; existing tests light a flow through them; runs drop frames into the screens they saw.
 * `teach` loops the three beats; `build` shows the beats up to `stage` and holds there.
 */
function MapSketch({ mode, stage = "done" }: { mode: "teach" | "build"; stage?: Stage }) {
  const flow = FLOW.map(mid);
  const flowPath = flow.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  return (
    <svg viewBox="0 0 520 300" className={cn(styles.sketch, mode === "teach" ? styles.teach : styles.build, "max-w-[520px]")} data-stage={stage} aria-hidden>
      {REGIONS.map((r, i) => (
        <g key={r.key}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="14" className={styles.sketchRegion} style={d(i * 160)} />
          <text x={r.x + 12} y={r.y + 18} className={styles.sketchLabel}>
            {r.label}
          </text>
        </g>
      ))}
      {LINKS.map(([a, b], i) => {
        const p = mid(a);
        const q = mid(b);
        const sameRow = p.y === q.y;
        const path = sameRow ? `M${p.x + SW / 2},${p.y} L${q.x - SW / 2},${q.y}` : `M${p.x},${p.y + SH / 2} L${q.x},${q.y - SH / 2}`;
        return <path key={`${a}-${b}`} d={path} className={styles.sketchLink} style={d(500 + i * 90)} />;
      })}
      {SCREENS.map((s, i) => (
        <rect key={s.id} x={s.x} y={s.y} width={SW} height={SH} rx="7" className={styles.sketchScreen} style={d(250 + i * 70)} />
      ))}
      <path d={flowPath} className={styles.sketchFlow} />
      {SEEN.map((id, i) => {
        const s = byId.get(id)!;
        return (
          <g key={id} className={styles.sketchFrameGroup} style={d(i * 160)}>
            <rect x={s.x} y={s.y} width={SW} height={SH} rx="7" className={styles.sketchFrame} />
            <rect x={s.x + 7} y={s.y + 10} width={SW - 20} height="5" rx="2.5" className={styles.sketchFrameBar} />
            <rect x={s.x + 7} y={s.y + 21} width={SW - 14} height="14" rx="3" className={styles.sketchFrameBar} opacity="0.55" />
            <rect x={s.x + 7} y={s.y + 41} width={SW - 26} height="5" rx="2.5" className={styles.sketchFrameBar} opacity="0.7" />
          </g>
        );
      })}
      {mode === "build" && stage !== "done" ? <rect x="0" y="0" width="520" height="14" rx="7" className={styles.scan} style={{ "--h": "286px" } as CSSProperties} /> : null}
    </svg>
  );
}

const SOURCES: { key: EvidenceSource; icon: typeof FileCode2; title: string; text: string }[] = [
  { key: "code", icon: FileCode2, title: "Code", text: "Screens, routes, navigation, API calls and data models. Seconds, no model, no device." },
  { key: "tests", icon: FlaskConical, title: "Existing tests", text: "The flows your tests already walk, read from the repository and never stored." },
  { key: "live", icon: Radio, title: "Live", text: "What runs actually reached, with a frame of each screen and the calls it made." },
];

/**
 * No map yet: what the map is, the three sources it is built from (each lighting with its beat
 * of the looping sketch), and the button that builds it. Reduced motion: the finished sketch.
 */
export function AppMapEmpty({ action, error, note }: { action: ReactNode; error?: string | null; note?: string | null }) {
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-6 md:items-center md:px-6">
      <div className={cn(cov.stage, styles.teach, "grid w-full max-w-[1100px] items-center gap-8 p-6 md:grid-cols-[1fr_1.15fr] md:p-10")} data-app-map-empty>
        <div className={styles.rise}>
          <h2 className="text-xl font-semibold text-fg">Map the whole app</h2>
          <p className="mt-2 max-w-md text-base text-fg-2">
            Every feature, screen, API call and record in one picture, built from what Embodent can already read. It is never a gate: the map gets sharper with every run, and what no run has reached
            stays in the fog.
          </p>
          <ul className="mt-5 grid gap-3">
            {SOURCES.map((s, i) => (
              <li key={s.key} className={cn(styles.source, "flex gap-3")} data-source={s.key}>
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-panel text-fg-2 shadow-[var(--shadow-sm)]">
                  <s.icon className="size-3.5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">
                    <span className="mr-1.5 text-muted tabular-nums">{i + 1}</span>
                    {s.title}
                  </p>
                  <p className="text-sm text-fg-2">{s.text}</p>
                </div>
              </li>
            ))}
          </ul>
          {note && !error ? (
            <p className="mt-4 rounded-lg border border-border bg-panel px-3 py-2 text-sm text-fg-2" data-app-map-note>
              {note}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-lg border border-border bg-panel px-3 py-2 text-sm text-danger" data-app-map-error>
              The last build failed: {error}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center gap-3">{action}</div>
        </div>
        <div className="flex justify-center">
          <MapSketch mode="teach" />
        </div>
      </div>
    </div>
  );
}

/** How long each source's beat shows before the next starts. The build is one job without
 * per-source progress, so the beats advance on a timer and the last holds until it is done. */
const BEAT_MS = 2400;
const BEATS: { key: Exclude<Stage, "idle" | "done">; label: string; detail: string }[] = [
  { key: "code", label: "Reading the code", detail: "Screens, routes, navigation, endpoints and data models" },
  { key: "tests", label: "Reading the existing tests", detail: "The flows they walk and the endpoints they mock" },
  { key: "live", label: "Reading the runs", detail: "Screens reached, calls made, records written" },
];

/** What a source is called where the panel says it was reused: "Reused the code read 2 days ago". */
const REUSED_WORD: Record<EvidenceSource, string> = { code: "the code", tests: "the tests", live: "the runs" };

/** The beats a build plays: the sources it reads (all three when it does not say). */
export function plannedBeats(build: Pick<AppMapBuild, "planned"> | null | undefined): typeof BEATS {
  const planned = build?.planned;
  return planned && planned.length ? BEATS.filter((b) => planned.includes(b.key)) : BEATS;
}

/** The sources a build reuses from an earlier read, with the words the panel says for each. */
export function reusedLines(build: Pick<AppMapBuild, "planned" | "reused"> | null | undefined, now?: Date): { key: EvidenceSource; text: string }[] {
  if (!build?.planned?.length) return [];
  return (["code", "tests", "live"] as const)
    .filter((s) => !build.planned!.includes(s))
    .map((s) => {
      const at = build.reused?.[s];
      return { key: s, text: at ? `Reused ${REUSED_WORD[s]} read ${fmtRelative(at, now)}` : `Reused ${REUSED_WORD[s]} as last read` };
    });
}

function useStage(done: boolean, beats: typeof BEATS): Stage {
  // -1: one blank frame first, so the code's skeleton has something to draw in from.
  const [i, setI] = useState(-1);
  useEffect(() => {
    if (done || i >= beats.length - 1) return;
    const t = window.setTimeout(() => setI((v) => v + 1), i < 0 ? 60 : BEAT_MS);
    return () => window.clearTimeout(t);
  }, [i, done, beats.length]);
  if (done) return "done";
  return i < 0 ? "idle" : beats[Math.min(i, beats.length - 1)].key;
}

/**
 * The build's steps: each source it reads, done only once it has read it (a read that failed says
 * so), then each source it reused from an earlier read, said as that (never "Reading the code"
 * ticked when the code was not read).
 */
function Beats({ stage, compact = false, build }: { stage: Stage; compact?: boolean; build?: AppMapBuild | null }) {
  const beats = plannedBeats(build);
  const at = stage === "done" ? beats.length : Math.max(0, beats.findIndex((b) => b.key === stage));
  return (
    <ol className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2.5")} aria-live="polite" data-app-map-beats>
      {beats.map((b, i) => {
        const failed = stage === "done" && build?.ran?.[b.key] === false;
        const state = failed ? "failed" : i < at ? "done" : i === at ? "active" : "pending";
        return (
          <li key={b.key} className={cn(cov.step, "flex items-start gap-2")} data-step={b.key} data-step-state={state} style={{ "--i": i } as CSSProperties}>
            <span className={cn(cov.stepMark, "mt-0.5")} aria-hidden>
              {state === "done" ? <Check className="size-3" strokeWidth={2.5} /> : state === "failed" ? <X className="size-3 text-danger" strokeWidth={2.5} /> : null}
            </span>
            <span className="min-w-0">
              <span className={cn("block", compact ? "text-xs" : "text-sm", state === "pending" ? "text-muted" : state === "failed" ? "text-danger" : "text-fg")}>
                {failed ? `${b.label}: it could not be read` : b.label}
              </span>
              {compact ? null : <span className="block text-xs text-muted">{b.detail}</span>}
            </span>
          </li>
        );
      })}
      {reusedLines(build).map((r, i) => (
        <li key={r.key} className={cn(cov.step, "flex items-start gap-2")} data-step={r.key} data-step-state="reused" style={{ "--i": beats.length + i } as CSSProperties}>
          <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-muted" aria-hidden>
            <History className="size-3" />
          </span>
          <span className={cn("block text-muted", compact ? "text-xs" : "text-sm")}>{r.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The first build, live: the sketch reveals the map source by source (the code's skeleton draws
 * in, then a test's flow lights, then run frames pop into the screens) beside the same steps as
 * a checklist. Reduced motion: each beat appears without movement.
 */
export function AppMapBuilding({ done = false, build = null }: { done?: boolean; build?: AppMapBuild | null }) {
  const stage = useStage(done, plannedBeats(build));
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-6 md:items-center md:px-6">
      <div className={cn(cov.stage, "grid w-full max-w-[1100px] items-center gap-8 p-6 md:grid-cols-[1.15fr_1fr] md:p-10")} role="status" data-app-map-building data-stage={stage}>
        <div className="flex justify-center">
          <MapSketch mode="build" stage={stage} />
        </div>
        <div className={styles.rise}>
          <p className="flex items-center gap-2 text-base font-semibold text-fg">
            <MapIcon className="size-4 text-fg-2" aria-hidden />
            {done ? "Drawing the map" : "Building the map"}
          </p>
          <p className="mb-4 mt-1 max-w-sm text-sm text-fg-2">Nothing runs on a device and no model is called. This takes seconds.</p>
          <Beats stage={stage} build={build} />
        </div>
      </div>
    </div>
  );
}

/** A rebuild, over the map it will replace: the same beats, compact, in a card. */
export function AppMapRebuilding({ done = false, build = null }: { done?: boolean; build?: AppMapBuild | null }) {
  const stage = useStage(done, plannedBeats(build));
  return (
    <div
      className={cn(styles.overlay, "pointer-events-none absolute right-4 top-14 z-20 w-[260px] rounded-xl border border-border bg-raised/95 px-4 py-3 shadow-md backdrop-blur max-md:left-4 max-md:right-4 max-md:w-auto")}
      role="status"
      data-app-map-rebuilding
      data-stage={stage}
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{done ? "Drawing the new map" : "Rebuilding the map"}</p>
      <Beats stage={stage} compact build={build} />
    </div>
  );
}

export function BuildButton({ busy, label = "Build the map" }: { busy: boolean; label?: string }) {
  return (
    <RunAction kind="map" variant="primary" size="lg" loading={busy} data-app-map-build>
      {busy ? null : <MapIcon />}
      {label}
    </RunAction>
  );
}
