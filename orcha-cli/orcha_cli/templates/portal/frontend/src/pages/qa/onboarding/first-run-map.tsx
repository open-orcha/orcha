import { useState, type MutableRefObject } from "react";
import { Link } from "./ui";
import { AlertTriangle, ArrowUpRight, Check, Clock, ListChecks, Map as MapIcon, Play, RotateCcw, Shuffle, X } from "../map/kit/icons";
import { useWithReturn } from "./ui";
import { Button, buttonVariants } from "./ui";
import { PlatformIcon } from "./ui";
import { LiveDeviceView } from "../runs/live/LiveDeviceView";
import type { TargetKind } from "./types";
import { cn } from "./ui";
import type { Plan } from "./choreo";
import { duration, type Billing, type FirstRunOptions, type FirstTest, type MapAction, type OnboardingMap, type ScreenFirstRun } from "./contract";
import { fallbackFirstTest, smokeSuite } from "./coverage";
import { resultWords, type ResultNext, type ResultTone } from "./first-run-result";
import { MapStage } from "./map-stage";
import { TeachingState } from "./scenes";
import styles from "./onboarding-map.module.css";

const PLATFORM_WORD: Record<string, string> = { ios: "iOS", android: "Android", web: "Web" };

/** The run the map shows: one still going first, else the newest finished one. */
export function currentRun(map: OnboardingMap): { screenId: string; run: ScreenFirstRun } | null {
  let best: { screenId: string; run: ScreenFirstRun } | null = null;
  for (const s of map.screens) {
    if (!s.first_run) continue;
    const live = s.first_run.verdict === "running" || s.first_run.verdict === "queued";
    if (live) return { screenId: s.id, run: s.first_run };
    best ??= { screenId: s.id, run: s.first_run };
  }
  return best;
}

/** Text with a launch argument (`-denly-uitest-reset`) kept on one line, never broken at its hyphens. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s-[\w.-]+)/).map((part, i) =>
        i % 2 ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** After a first run, the test to offer instead: Embodent's pick when it is another one, else the
 * first other scenario on the map. */
function anotherTest(map: OnboardingMap, ran: string): FirstTest | null {
  if (map.first_test && map.first_test.scenario_id !== ran) return map.first_test;
  const others = allScenarios(map).filter((x) => x.id !== ran);
  const other = others.find((x) => !x.unfit) ?? others[0];
  if (!other) return null;
  return {
    scenario_id: other.id,
    name: other.name,
    screen_id: other.screenId,
    platform: other.platform,
    estimate_seconds: 60,
    estimate_usd: 0,
    why: other.unfit ? `Not checkable yet: ${other.unfit}.` : "",
  };
}

/** Every scenario on the map, for "Pick another". */
function allScenarios(map: OnboardingMap) {
  // A scenario that reaches several screens is offered once, on the first of them.
  const seen = new Set<string>();
  return map.screens.flatMap((s) =>
    s.scenarios.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).map((x) => ({ ...x, screenId: s.id, screen: s.name, platform: s.platform })),
  );
}

/**
 * Embodent's pick for the first test, with why it was picked, where it runs and what it costs;
 * "Run the riskiest scenarios" and "Pick another" beside it.
 */
export function FirstTestCard({
  map,
  pick,
  device,
  busy,
  onRun,
  onPick,
  compact = false,
  again = false,
}: {
  map: OnboardingMap;
  pick: FirstTest;
  device: (platform?: string) => string;
  busy: MapAction | null;
  onRun: (options: FirstRunOptions) => void;
  onPick: (pick: FirstTest) => void;
  compact?: boolean;
  /** After a first run: the person picks another test, the list open. */
  again?: boolean;
}) {
  const [choosing, setChoosing] = useState(again);
  const smoke = smokeSuite(map);
  const screen = pick.screen_id ? map.screens.find((s) => s.id === pick.screen_id) : null;
  const options = allScenarios(map);
  return (
    <section className={cn(styles.rise, "rounded-xl border border-primary/30 bg-panel p-4 shadow-sm")} aria-labelledby="onb-first-test" data-onboarding-first-test={pick.scenario_id}>
      <p className="text-xs font-medium text-primary">{again ? "Pick another test to run first" : "Embodent\u2019s pick for your first test"}</p>
      <h2 id="onb-first-test" className="mt-1 text-lg font-semibold tracking-[-0.01em] text-fg">
        {pick.name}
      </h2>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-2">
        {screen ? (
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Screen</dt>
            <MapIcon className="size-3.5 text-muted" aria-hidden />
            <dd>{screen.name}</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Runs on</dt>
          {pick.platform && pick.platform in PLATFORM_WORD ? <PlatformIcon kind={pick.platform as TargetKind} className="size-3.5 text-muted" /> : null}
          <dd>{device(pick.platform)}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Estimate</dt>
          <Clock className="size-3.5 text-muted" aria-hidden />
          <dd>
            about {duration(pick.estimate_seconds)}
          </dd>
        </div>
      </dl>
      {pick.why && !compact ? (
        <p className="mt-2 text-sm text-muted">
          <Words text={pick.why} />
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="lg" loading={busy === "first_run"} onClick={() => onRun({ scenario_id: pick.scenario_id, ...(pick.platform === "ios" || pick.platform === "android" || pick.platform === "web" ? { platform: pick.platform } : {}) })} data-onboarding-run-first>
          <Play aria-hidden /> {again ? "Run this test" : "Run your first test"}
        </Button>
        {smoke.count > 1 ? (
          <Button
            size="lg"
            className="h-auto min-h-8 max-w-full shrink whitespace-normal py-1 text-left"
            onClick={() => onRun({ suite: "smoke" })}
            disabled={busy === "first_run"}
            data-onboarding-run-smoke
          >
            <ListChecks aria-hidden /> Run the {smoke.count} riskiest scenarios · about {duration(smoke.estimate_seconds)}
          </Button>
        ) : null}
        {options.length > 1 ? (
          <Button size="lg" variant="ghost" aria-expanded={choosing} aria-controls="onb-pick-another" onClick={() => setChoosing((c) => !c)} data-onboarding-pick-another>
            <Shuffle aria-hidden /> Pick another
          </Button>
        ) : null}
      </div>
      {choosing ? (
        <fieldset id="onb-pick-another" className="mt-3 max-h-64 min-w-0 overflow-y-auto rounded-lg border border-border p-1.5">
          <legend className="sr-only">Pick the first test</legend>
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-hover">
              <input
                type="radio"
                name="onb-first-pick"
                className="accent-[var(--color-primary)]"
                checked={o.id === pick.scenario_id}
                onChange={() => {
                  onPick({ scenario_id: o.id, name: o.name, screen_id: o.screenId, platform: o.platform, estimate_seconds: pick.estimate_seconds, estimate_usd: pick.estimate_usd, why: o.unfit ? `Not checkable yet: ${o.unfit}.` : "You picked this one." });
                  setChoosing(false);
                }}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-fg">{o.name}</span>
                <span className="truncate text-2xs text-muted sm:hidden">
                  {o.screen} · {o.status === "draft" ? "draft" : "your test"}
                </span>
                {o.unfit ? (
                  <span className="text-2xs text-muted">
                    Not checkable yet: <Words text={o.unfit} />
                  </span>
                ) : null}
              </span>
              <span className="hidden shrink-0 text-xs text-muted sm:inline">
                {o.screen} · {o.status === "draft" ? "draft" : "your test"}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </section>
  );
}

const TONE: Record<ResultTone, { card: string; mark: string; color: string }> = {
  pass: { card: "border-success/35 bg-success/5", mark: "bg-success", color: "var(--v2-ok)" },
  fail: { card: "border-danger/30 bg-danger/5", mark: "bg-danger", color: "var(--v2-danger)" },
  warn: { card: "border-warning/35 bg-warning/5", mark: "bg-warning", color: "var(--v2-warn)" },
};

/**
 * What really happened, calm (`resultWords`, #486): "Passed in 42 s", the test's finding, the
 * starting state that could not be set up, a test that could not be checked, or a run that broke.
 * Then the next step that fits: open the run, pick another test, try again, the suite, the map.
 */
export function ResultCard({
  run,
  screen,
  smoke,
  busy,
  onSuite,
  onOpenMap,
  onPickAnother,
  onRetry,
  leaving,
  findings,
}: {
  run: ScreenFirstRun;
  /** The screen the result landed on. */
  screen: string | null;
  billing: Billing;
  /** The suite's size and estimate, shown on its button before it starts. */
  smoke: { count: number; estimate_usd: number; estimate_seconds: number };
  busy: MapAction | null;
  onSuite: () => void;
  onOpenMap: () => void;
  /** Null when there is no other test to pick. */
  onPickAnother: (() => void) | null;
  onRetry: () => void;
  leaving: boolean;
  /** Findings the run reported along the way: a test can pass and still see something wrong. */
  findings?: number;
}) {
  const withReturn = useWithReturn();
  const words = resultWords(run, screen);
  const tone = TONE[words.tone];
  const Mark = words.tone === "pass" ? Check : words.tone === "warn" ? AlertTriangle : X;
  // There is no Ask here: its next step is left out.
  const shown = words.next.filter((n) => (n === "ask" ? false : n === "suite" ? smoke.count > 1 : n === "pick" ? onPickAnother !== null : n === "open_run" ? Boolean(words.runId) : true));
  const primary = shown[0];
  const step = (n: ResultNext) => {
    const variant = n === primary ? "primary" : n === "ask" || n === "open_map" ? "ghost" : undefined;
    switch (n) {
      case "open_map":
        return (
          <Button key={n} variant={variant} size="lg" onClick={onOpenMap} loading={leaving} data-onboarding-open-map>
            <MapIcon aria-hidden /> Go to Quality
          </Button>
        );
      case "open_run":
        return (
          <Link
            key={n}
            href={withReturn(`/qa?view=sessions&session=${encodeURIComponent(words.runId ?? "")}`)}
            className={cn(buttonVariants({ variant: n === primary ? "primary" : undefined, size: "lg" }))}
            data-onboarding-open-run={words.runId}
          >
            {words.runLabel} <ArrowUpRight aria-hidden />
          </Link>
        );
      case "pick":
        return (
          <Button key={n} variant={variant} size="lg" onClick={() => onPickAnother?.()} data-onboarding-pick-another-after>
            <Shuffle aria-hidden /> Pick another test
          </Button>
        );
      case "retry":
        return (
          <Button key={n} variant={variant} size="lg" onClick={onRetry} loading={busy === "first_run"} data-onboarding-retry>
            <RotateCcw aria-hidden /> Try again
          </Button>
        );
      case "suite":
        return (
          <Button key={n} variant={variant} size="lg" onClick={onSuite} loading={busy === "first_run"} data-onboarding-next-suite>
            <ListChecks aria-hidden /> Run the suite ({smoke.count}) · about {duration(smoke.estimate_seconds)}
          </Button>
        );
      default:
        return null;
    }
  };
  return (
    <section
      className={cn(styles.rise, "rounded-xl border p-4", tone.card)}
      aria-labelledby="onb-result"
      data-onboarding-result={run.verdict}
      data-onboarding-outcome={words.outcome}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(styles.verdictMark, styles.halo, "flex size-9 shrink-0 items-center justify-center rounded-full text-white", tone.mark)}
          style={{ ["--c" as string]: tone.color }}
          aria-hidden
        >
          <Mark className="size-5" strokeWidth={2.6} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="onb-result" className="text-lg font-semibold tracking-[-0.01em] text-fg">
            {words.title}
          </h2>
          <p className="break-words text-sm text-fg-2" data-onboarding-result-body>
            {words.body}
          </p>
          {words.aside ? (
            <p className="mt-1 break-words text-xs text-muted" data-onboarding-result-aside>
              {words.aside}
            </p>
          ) : null}
          {findings ? (
            <p className="mt-1 text-xs text-fg-2" data-onboarding-result-findings>
              The run also reported {findings} {findings === 1 ? "finding" : "findings"}. <Link href={withReturn("/qa?view=sessions")}>See them in Runs</Link>
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">{shown.map(step)}</div>
    </section>
  );
}

/**
 * First run: Embodent's pick, run on the device with the screen streaming beside the map (its
 * node pulses), then the verdict lands on the node and the next steps follow. Without anything
 * to run yet, it teaches what the step does and offers the older ways to start.
 */
export function FirstRunMap({
  map,
  planRef,
  busy,
  device,
  onAct,
  onOpenMap,
  leaving,
  more,
}: {
  map: OnboardingMap;
  planRef: MutableRefObject<Plan | null>;
  busy: MapAction | null;
  device: (platform?: string) => string;
  onAct: (action: MapAction, options?: FirstRunOptions) => void;
  onOpenMap: () => void;
  leaving: boolean;
  /** The older first-run choices (an exploration, a scenario file), folded under "More ways to start". */
  more: React.ReactNode;
}) {
  const [override, setOverride] = useState<FirstTest | null>(null);
  const [showMore, setShowMore] = useState(false);
  // "Pick another test" after a run: the pick card again, its list open.
  const [again, setAgain] = useState(false);
  const current = currentRun(map);
  const running = current && (current.run.verdict === "running" || current.run.verdict === "queued");
  const pick = override ?? (again && current ? anotherTest(map, current.run.scenario_id) : null) ?? fallbackFirstTest(map);
  const screen = current ? map.screens.find((s) => s.id === current.screenId) : null;
  const smoke = smokeSuite(map);
  const focusId = current?.screenId ?? pick?.screen_id ?? null;
  const platform = (screen?.platform ?? pick?.platform ?? "ios") as TargetKind;

  const moreBlock = (
    <div className="flex flex-col gap-2">
      <button type="button" className="self-start text-xs text-fg-2 hover:text-fg" aria-expanded={showMore} onClick={() => setShowMore((s) => !s)} data-onboarding-more-ways>
        {showMore ? "Hide the other ways to start" : "More ways to start: explore the app, or check scenarios"}
      </button>
      {showMore ? <div className="rounded-lg border border-border bg-bg p-4">{more}</div> : null}
    </div>
  );

  if (!pick && !current) {
    return (
      <div className="flex flex-col gap-3">
        <TeachingState
          scene="first_run"
          title="Nothing to run yet"
          action={
            <Button variant="primary" onClick={onOpenMap} loading={leaving} data-onboarding-open-map>
              Go to Quality
            </Button>
          }
        >
          Bring your tests in or draft scenarios for the gaps, and Embodent picks the best one to run first: short, no sign-in, on a screen that matters.
        </TeachingState>
        {moreBlock}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {current && !running ? (
        <ResultCard
          run={current.run}
          screen={screen?.name ?? null}
          smoke={smoke}
          billing={map.billing}
          busy={busy}
          onSuite={() => onAct("first_run", { suite: "smoke" })}
          onOpenMap={onOpenMap}
          onPickAnother={allScenarios(map).length > 0 ? () => setAgain(true) : null}
          onRetry={() => onAct("first_run", { scenario_id: current.run.scenario_id, ...(pick?.platform === "ios" || pick?.platform === "android" || pick?.platform === "web" ? { platform: pick.platform } : {}) })}
          leaving={leaving}
          findings={map.phases.first_run.counts?.findings}
        />
      ) : null}
      {(!current || (again && !running)) && pick ? (
        <FirstTestCard
          map={map}
          pick={pick}
          device={device}
          busy={busy}
          again={Boolean(current)}
          onRun={(o) => {
            setAgain(false);
            setOverride(null);
            onAct("first_run", o);
          }}
          onPick={setOverride}
        />
      ) : null}
      <div className={cn("grid gap-3", running ? "lg:grid-cols-[300px_minmax(0,1fr)]" : "")}>
        {running && current ? (
          <section className="flex min-h-[420px] flex-col gap-2 rounded-xl border border-border bg-panel p-3" aria-label="The device, live" data-onboarding-first-live>
            <p className="text-sm font-medium text-fg" role="status">
              {current.run.verdict === "queued" ? "Waiting for the device…" : `Running ${pick?.name ?? "the first test"}`}
            </p>
            {current.run.run_id ? (
              <LiveDeviceView sessionId={current.run.run_id} platform={platform} deviceName={device(platform)} fit />
            ) : (
              <TeachingState scene="first_run" title="Getting the device ready" className="flex-1 justify-center" live />
            )}
          </section>
        ) : null}
        <MapStage
          map={map}
          planRef={planRef}
          mode="first_run"
          label="Map with the first run"
          focusId={focusId}
          zoomTo={running ? focusId : null}
          pulseId={running ? focusId : null}
        />
      </div>
      {!running ? moreBlock : null}
    </div>
  );
}
