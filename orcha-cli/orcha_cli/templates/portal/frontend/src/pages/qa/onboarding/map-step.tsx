import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { Check, CircleHelp, Minus, PanelRightClose, PanelRightOpen, RotateCcw, TriangleAlert, X } from "../map/kit/icons";
import { Button, Link } from "./ui";
import { PLATFORM_NAMES } from "./ui";
import type { TargetKind } from "./types";
import { cn } from "./ui";
import type { Plan } from "./choreo";
import { frameworkName, type MapAction, type OnboardingMap, type PhaseInfo, type RunLiveOptions } from "./contract";
import { coveringFrameworks } from "./coverage";
import { mapBeat, type MapBeat } from "./flow";
import { WithCode } from "./ui";
import { blockedRequestHref, browserStorage, doneNote, failureText, liveBannerKind, liveBuildWords, livePercent, livePlatformOf, liveStageText, passScreens, screensSeen, liveTitle, readPanelOpen, retryDepth, writePanelOpen, type LiveBuild } from "./live-pass";
import { LiveRunPanel } from "./live-run-panel";
import { NO_AGENT } from "../setup/setup";
import { MapStage } from "./map-stage";
import { TeachingState } from "./scenes";
import type { MapLoad } from "./use-onboarding-map";
import styles from "./onboarding-map.module.css";

/** What the Map step says, before the pass starts, about the backend it would reach (#453). */
export type LiveBackendLine = { tone: "production" | "unknown"; text: string } | null;

const d = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

function PhaseGlyph({ state }: { state: PhaseInfo["state"] }) {
  if (state === "done") return <Check className="size-3 text-success" strokeWidth={2.5} aria-hidden />;
  if (state === "skipped") return <Minus className="size-3 text-muted" strokeWidth={2.5} aria-hidden />;
  if (state === "failed") return <X className="size-3 text-danger" strokeWidth={2.5} aria-hidden />;
  if (state === "running")
    return <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent motion-reduce:animate-none" aria-hidden />;
  return <span className="size-2 rounded-full border border-border-strong" aria-hidden />;
}

const STATE_WORD: Record<PhaseInfo["state"], string> = { pending: "next", running: "in progress", done: "done", skipped: "skipped", failed: "failed" };

/** The three beats of the map, as a quiet track: what is done, what runs, what comes next. */
export function PhaseTrack({ map }: { map: OnboardingMap }) {
  const items: { key: "code_map" | "tests" | "live"; label: string }[] = [
    { key: "code_map", label: "Read the code" },
    { key: "tests", label: "Match your tests" },
    { key: "live", label: "Live pass" },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label="Map progress">
      {items.map((it, i) => {
        const info = map.phases[it.key];
        return (
          <li key={it.key} className="flex items-center gap-1" data-phase={it.key} data-phase-state={info.state}>
            {i > 0 ? <span className="mx-1 h-px w-4 bg-border-strong" aria-hidden /> : null}
            <span className={cn("flex h-6 items-center gap-1.5 rounded-full border px-2", info.state === "running" ? "border-primary/40 bg-primary/5 text-fg" : "border-border text-fg-2")}>
              <PhaseGlyph state={info.state} />
              <span>{it.label}</span>
              <span className="sr-only">: {STATE_WORD[info.state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The frameworks the map matched, as badges that sweep in; hovering one lights its screens. */
export function FrameworkBadges({ map, onHighlight, active }: { map: OnboardingMap; onHighlight: (fw: string | null) => void; active: string | null }) {
  const fws = coveringFrameworks(map.screens);
  if (fws.length === 0) return null;
  return (
    <ul className={cn(styles.tones, "flex flex-wrap items-center gap-1.5")} aria-label="Your tests, by framework" data-onboarding-frameworks>
      {fws.map((f, i) => (
        <li key={f.framework} className={styles.badge} style={d(i * 140)} data-dim={active !== null && active !== f.framework}>
          <button
            type="button"
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md border bg-panel px-2 text-xs transition-colors",
              active === f.framework ? "border-[color:var(--c-yours)] text-fg" : "border-border text-fg-2 hover:border-border-strong",
            )}
            aria-pressed={active === f.framework}
            onMouseEnter={() => onHighlight(f.framework)}
            onMouseLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(f.framework)}
            onBlur={() => onHighlight(null)}
            onClick={() => onHighlight(active === f.framework ? null : f.framework)}
            data-framework={f.framework}
          >
            <span className={cn(styles.yours, styles.swatch)} aria-hidden />
            <span className="font-medium text-fg">{frameworkName(f.framework)}</span>
            <span className="tabular-nums text-muted">
              {f.tests} {f.tests === 1 ? "test" : "tests"} · {f.screens} {f.screens === 1 ? "screen" : "screens"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function beatLine(beat: MapBeat, map: OnboardingMap | null, device: string): string {
  const n = map?.screens.length ?? 0;
  const liveSeen = map ? screensSeen(map) : 0;
  const liveTotal = map ? passScreens(map).length : 0;
  switch (beat) {
    case "waiting":
      return "Opening the repository";
    case "code":
      return n ? `Reading the code · ${n} ${n === 1 ? "screen" : "screens"} so far` : "Reading the code";
    case "tests":
      return `Matching your tests to ${n} screens`;
    case "live_offer":
      return `${n} screens mapped from the code`;
    case "live":
      return map?.live_run?.depth === "deeper" ? `Mapping deeper on ${device} · ${liveSeen} of ${liveTotal} screens seen` : `Mapping the main areas on ${device} · ${liveSeen} of ${liveTotal} screens seen`;
    case "failed":
      return "The map stopped";
    case "ready":
      return `${n} screens mapped`;
  }
}

/** "View run": opens or collapses the run beside the map. */
function ViewRunButton({ open, panelId, onToggle }: { open: boolean; panelId: string; onToggle: () => void }) {
  return (
    <Button variant="ghost" onClick={onToggle} aria-expanded={open} aria-controls={panelId} data-onboarding-live-view-run>
      {open ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />} {open ? "Hide run" : "View run"}
    </Button>
  );
}

/** The live pass: offered with its cost, the backend it would reach and a Run button, and it
 * waits for that click (#454: it spends money and holds a device, so it never starts by
 * itself); then while it builds and runs, then how it ended (done on its budget, or stopped with
 * why and a Retry). */
function LiveCard({
  map,
  beat,
  device,
  wanted,
  busy,
  panelOpen,
  panelId,
  backendLine,
  building,
  onTogglePanel,
  onRun,
  onSkip,
}: {
  map: OnboardingMap;
  beat: MapBeat;
  device: string;
  /** On by default; turned off on the We found sheet it is skipped when its turn comes. */
  wanted: boolean;
  busy: MapAction | null;
  panelOpen: boolean;
  panelId: string;
  backendLine: LiveBackendLine;
  /** Embodent builds the app for the pass (in the local checkout, or from a clone). */
  building: LiveBuild;
  onTogglePanel: () => void;
  onRun: (options?: RunLiveOptions) => void;
  onSkip: () => void;
}) {
  const info = map.phases.live;
  const kind = liveBannerKind(map, beat);
  const run = map.live_run;
  // Another phone (or the web) the pass can map on instead, when this one stopped.
  const here = livePlatformOf(map);
  const other = map.found.platforms.map((p) => p.kind).find((k) => k !== here) ?? null;
  const canView = Boolean(run?.run_id);

  if (kind === "running") {
    // Before the device shows the app: what the pass is doing ("Building the app" while it
    // compiles, never "Waiting for a device" then).
    const prep = liveStageText(run, device, building);
    // "no agent" is answered by the setup state above, never as a line here.
    const noAgent = info.blocked_reason === NO_AGENT;
    const blockedWhy = noAgent ? null : info.blocked_reason ?? null;
    return (
      <div
        className={cn(styles.beat, "flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5")}
        data-onboarding-live="running"
        data-onboarding-live-stage={run?.stage ?? (run?.run_id ? "mapping" : "queued")}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg" aria-live="polite">
            {blockedWhy ?? (noAgent ? "Waiting for an agent" : prep ? prep.title : liveTitle("running", map, device))}
          </p>
          {blockedWhy && info.request_id ? <Link href={blockedRequestHref(info.request_id)} className="text-xs text-fg-2 underline underline-offset-2 hover:text-fg" data-onboarding-live-request>Open the request</Link> : null}
          <p className="text-xs text-muted" hidden={!!blockedWhy}>
            {noAgent ? "The pass starts when one is added above. " : prep ? `${prep.detail} ` : run?.depth === "deeper" ? "The riskiest screens first, then every screen not seen yet. " : "Quick map: the entry screen and each main area, once. "}
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${livePercent(map)}%` }} />
          </div>
        </div>
        <ViewRunButton open={panelOpen} panelId={panelId} onToggle={onTogglePanel} />
        <Button onClick={onSkip} loading={busy === "skip_live"} data-onboarding-live-skip>
          Skip the rest
        </Button>
      </div>
    );
  }
  if (kind === "done") {
    const note = doneNote(info.note);
    return (
      <div className={cn(styles.beat, "flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2.5")} data-onboarding-live="done">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{liveTitle("done", map, device)}</p>
          <p className="text-xs text-muted" data-onboarding-live-note>
            {note ? `${note}. ` : ""}Map deeper visits the riskiest screens nothing tests yet, then every screen not seen so far.
          </p>
        </div>
        {canView ? <ViewRunButton open={panelOpen} panelId={panelId} onToggle={onTogglePanel} /> : null}
        <Button onClick={() => onRun({ depth: "deeper" })} loading={busy === "run_live"} data-onboarding-live-deeper>
          Map deeper
        </Button>
      </div>
    );
  }
  if (kind === "failed") {
    return (
      <div className={cn(styles.beat, "flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5")} role="alert" data-onboarding-live="failed">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">The live pass stopped</p>
          <p className="text-xs text-fg-2" data-onboarding-live-note>
            <WithCode text={failureText(info.note)} />. The map keeps everything it saw and what the code showed. Retry runs the pass again on {device}.
          </p>
        </div>
        {canView ? <ViewRunButton open={panelOpen} panelId={panelId} onToggle={onTogglePanel} /> : null}
        {other ? (
          <Button onClick={() => onRun({ depth: retryDepth(run), platform: other })} loading={busy === "run_live"} data-onboarding-live-other={other}>
            Map on {PLATFORM_NAMES[other]}
          </Button>
        ) : null}
        <Button variant="primary" onClick={() => onRun({ depth: retryDepth(run) })} loading={busy === "run_live"} data-onboarding-live-retry>
          <RotateCcw aria-hidden /> Retry
        </Button>
      </div>
    );
  }
  if (kind === "skipped") {
    return (
      <div className={cn(styles.beat, "flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2.5")} data-onboarding-live="skipped">
        <p className="min-w-0 flex-1 text-xs text-muted">No live pass yet: the map shows what the code and your tests say. A high-level map adds a real screenshot of each main area.</p>
        <Button onClick={() => onRun({ depth: "overview" })} loading={busy === "run_live"} data-onboarding-live-run>
          Run the high-level map
        </Button>
      </div>
    );
  }
  return (
    <div className={cn(styles.beat, "flex flex-col gap-2 rounded-lg border border-border bg-panel px-3 py-2.5")} data-onboarding-live="offer">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">
            Next: a high-level map on {device}
          </p>
          <p className="text-xs text-muted">
            {liveBuildWords(map.live_build, device)}, and visits its entry screen and each main area once, so the map shows what they really look like. It starts
            when you click Run{wanted ? "" : "; it is off, as chosen on the We found sheet"}.
          </p>
        </div>
        <Button variant="ghost" onClick={onSkip} loading={busy === "skip_live"} data-onboarding-live-skip>
          Skip
        </Button>
        <Button variant="primary" onClick={() => onRun({ depth: "overview" })} loading={busy === "run_live"} data-onboarding-live-run>
          Run the high-level map
        </Button>
      </div>
      {backendLine ? (
        <p
          className={cn(
            "flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs",
            backendLine.tone === "production" ? "border-danger/30 bg-danger/5 text-fg" : "border-warning/30 bg-warning/5 text-fg",
          )}
          data-onboarding-live-backend={backendLine.tone}
        >
          {backendLine.tone === "production" ? (
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
          ) : (
            <CircleHelp className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          )}
          {backendLine.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Map step, the hero moment: the repository on the left, files flying onto screens, the
 * tests lighting what they reach, then the live pass making each screen real. A waiting state
 * teaches what is about to happen; a missing route offers the classic drafting instead.
 */
export function MapStep({
  load,
  planRef,
  busy,
  device,
  livePass,
  backendLine = null,
  building = null,
  onAct,
  onRetry,
  onClassic,
}: {
  load: MapLoad;
  planRef: MutableRefObject<Plan | null>;
  busy: MapAction | null;
  /** The live pass's device, in a sentence ("any booted simulator", "Pixel 9 Pro"). */
  device: string;
  livePass: boolean;
  /** The backend the pass would reach, when it is production or cannot be told (#453). */
  backendLine?: LiveBackendLine;
  /** Embodent builds the app for the pass: in the local checkout or from a clone (#454). */
  building?: LiveBuild;
  onAct: (action: MapAction, options?: object) => void;
  onRetry: () => void;
  onClassic: () => void;
}) {
  const map = load.kind === "ready" ? load.map : null;
  const beat = mapBeat(map);
  const panelId = useId();
  // Collapsed unless this viewer opened it before (this browser only).
  const [panelOpen, setPanelOpen] = useState(() => readPanelOpen(browserStorage()));
  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      writePanelOpen(browserStorage(), !open);
      return !open;
    });
  }, []);
  const runLive = useCallback((options?: RunLiveOptions) => onAct("run_live", options), [onAct]);
  const [fw, setFw] = useState<string | null>(null);
  const highlight = useMemo(() => (fw && map ? new Set(map.screens.filter((s) => s.tests.some((t) => t.framework === fw)).map((s) => s.id)) : null), [fw, map]);
  // The person turned the live pass off on the We found sheet: skip it once its turn comes.
  const skipped = useRef(false);
  useEffect(() => {
    if (beat === "live_offer" && !livePass && !skipped.current && busy === null) {
      skipped.current = true;
      onAct("skip_live");
    }
  }, [beat, livePass, busy, onAct]);

  if (load.kind === "missing") {
    return (
      <TeachingState
        scene="map"
        title="Mapping is not available on this Embodent yet"
        action={
          <Button variant="primary" onClick={onClassic} data-onboarding-classic>
            Set the app by hand
          </Button>
        }
      >
        This build cannot read the project folder. Set the app in the app settings, and agents can still map it and draft scenarios for you to review.
      </TeachingState>
    );
  }
  if (load.kind === "error") {
    return (
      <TeachingState
        scene="map"
        title="The map did not load"
        action={
          <Button onClick={onRetry}>
            <RotateCcw aria-hidden /> Try again
          </Button>
        }
      >
        {load.message}
      </TeachingState>
    );
  }
  if (!map || beat === "waiting") {
    return (
      <TeachingState scene="map" title="Getting ready to map your app" live>
        Embodent reads every file that draws a screen, links each screen to the code behind it, then lights up the screens your tests already reach.
      </TeachingState>
    );
  }

  if (beat === "ready" && map.screens.length === 0) {
    const live = map.phases.live;
    return (
      <TeachingState
        scene="map"
        title="No screens found in the code"
        action={
          live.state === "skipped" || live.state === "failed" ? (
            <Button variant="primary" onClick={() => onAct("run_live", { depth: retryDepth(map.live_run) })} loading={busy === "run_live"} data-onboarding-live-run>
              {live.state === "failed" ? <RotateCcw aria-hidden /> : null}
              {live.state === "failed" ? "Retry the live pass" : "Run the live pass"}
            </Button>
          ) : null
        }
      >
        {map.phases.code_map.note ? `${map.phases.code_map.note}. ` : ""}
        {live.state === "failed" ? <>The live pass stopped. <WithCode text={failureText(live.note)} />. </> : ""}Embodent could not tie a screen to this code. The live pass finds screens by using the app on {device} instead.
      </TeachingState>
    );
  }

  const note = map.phases.code_map.state === "failed" ? map.phases.code_map.note : map.phases.tests.note;
  const banner = liveBannerKind(map, beat);
  // The run beside the map: while the pass runs (waiting for a device too), and after it ended
  // when there is a run to show.
  const showPanel = panelOpen && (banner === "running" || ((banner === "done" || banner === "failed") && Boolean(map.live_run?.run_id)));
  const platform: TargetKind = livePlatformOf(map);
  return (
    <div className="flex flex-col gap-3" data-onboarding-map-beat={beat}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p key={beat} className={cn(styles.beat, "text-sm font-medium text-fg")} data-onboarding-beat-line>
          {beatLine(beat, map, device)}
        </p>
        <PhaseTrack map={map} />
      </div>
      {beat === "code" || beat === "tests" ? <div className={cn(styles.shimmer, "-mt-1 h-px bg-border")} aria-hidden /> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FrameworkBadges map={map} onHighlight={setFw} active={fw} />
        {map.phases.tests.note && map.phases.tests.state !== "failed" ? (
          <span className="text-xs text-muted" data-onboarding-tests-note>
            {map.phases.tests.note}
          </span>
        ) : null}
      </div>
      <div className={cn("grid gap-3", showPanel ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "")} data-onboarding-live-panel-open={showPanel ? "" : undefined}>
        <MapStage map={map} planRef={planRef} mode="build" label={`Map of ${map.found.repo.name || "your app"}`} highlight={highlight} />
        {showPanel ? <LiveRunPanel id={panelId} run={map.live_run} kind={platform} device={device} building={building} blocked={map.phases.live.blocked_reason && map.phases.live.blocked_reason !== NO_AGENT ? { reason: map.phases.live.blocked_reason, requestId: map.phases.live.request_id } : null} onCollapse={togglePanel} /> : null}
      </div>
      <p className="-mt-1 text-xs text-muted" data-onboarding-map-grows>
        Every run adds what it sees to the map.
      </p>
      {map.found.ci?.length ? (
        <p className="text-xs text-muted" data-onboarding-ci>
          Also found: {map.found.ci.map((c) => `${c.provider} (${c.path})`).join(", ")}. Embodent can run in it later.
        </p>
      ) : null}
      {beat === "failed" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5" role="alert">
          <p className="min-w-0 flex-1 text-sm text-fg">{note ?? "Reading the code stopped before it finished."}</p>
          <Button onClick={() => onAct("start", { live: livePass ? "ask" : false })} loading={busy === "start"}>
            <RotateCcw aria-hidden /> Try again
          </Button>
        </div>
      ) : null}
      {banner ? (
        <LiveCard
          map={map}
          beat={beat}
          device={device}
          wanted={livePass}
          busy={busy}
          panelOpen={showPanel}
          panelId={panelId}
          backendLine={backendLine}
          building={building}
          onTogglePanel={togglePanel}
          onRun={runLive}
          onSkip={() => onAct("skip_live")}
        />
      ) : null}
    </div>
  );
}
