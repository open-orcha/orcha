import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { getJSON } from "../../../../api/client";
import { Compass, LayoutGrid, List, RefreshCw, ScanSearch, Sparkles, TrendingUp } from "../../map/kit/icons";
import { Button, PlatformIcon, cn, useToast, type TargetKind } from "../../map/kit";
import { getMap, PLATFORMS, type QaFeature, type QaNode } from "../../qaApi";
import { errText } from "../../parts";
import { coverageLinks, setCoverageLink, type CoverageLink } from "../api";
import type { Scenario } from "../adapt";
import { HumanGate, useScenarios } from "../context";
import { computeCoverage, type ScreenLink } from "./compute";
import { CoverageMap } from "./coverage-map";
import { CoveragePanel, STATE_DOT } from "./coverage-panel";
import { CoverageLoading, CoverageNoFeatures, CoverageNoScenarios, CoverageRecomputing } from "./coverage-states";
import { ago, headlineParts, plural, ranOn, riskSorted, sharedScenarios, stateCounts, stateOn, stateWords } from "./panel-model";
import styles from "../../map/coverage.module.css";
import { GrowthView } from "./growth/growth-view";
import growthStyles from "./growth/growth.module.css";
import { PLATFORM_LABEL, type Coverage, type CoverageState, type PlatformKey } from "./types";

interface Stored {
  features: QaFeature[];
  nodes: QaNode[];
  screens: ScreenLink[];
  links: CoverageLink[];
}

/** The map of every platform, and which scenarios each screen has. */
async function loadStored(cid: string, signal?: AbortSignal): Promise<Stored> {
  const [maps, onboarding, links] = await Promise.all([
    Promise.all(PLATFORMS.map((p) => getMap(cid, p, signal))),
    getJSON<{ screens?: ScreenLink[] }>(`/api/containers/${encodeURIComponent(cid)}/qa/onboarding`, signal).catch(() => null),
    coverageLinks(cid, signal).catch(() => []),
  ]);
  const features = new Map<string, QaFeature>();
  for (const m of maps) for (const f of m.features) features.set(f.key, f);
  return { features: [...features.values()], nodes: maps.flatMap((m) => m.nodes), screens: Array.isArray(onboarding?.screens) ? onboarding.screens : [], links };
}

const LEGEND: { state: CoverageState | "seen"; label: string }[] = [
  { state: "strong", label: "Strong" },
  { state: "covered", label: "Covered" },
  { state: "thin", label: "Thin" },
  { state: "failing", label: "Failing" },
  { state: "seen", label: "Seen, not tested" },
  { state: "untested", label: "Untested" },
];

function Headline({ text }: { text: string }) {
  return (
    <p className="text-xl font-semibold leading-snug tracking-[-0.01em] text-fg md:text-2xl" data-coverage-headline>
      {headlineParts(text).map((p, i) =>
        p.number ? (
          <span key={i} className={cn(styles.num, "text-[var(--color-primary)]")}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * Areas covered per platform. A scenario that applies to every platform covers each one on
 * paper, so the bar says where one ran: solid for areas with a result on that platform (failing
 * ones red), faded for areas whose scenarios have not run there yet, as the List's platform dots
 * say. The line under the bars says it in words when any area is covered only on paper.
 */
function PlatformBars({ report, weakest }: { report: Coverage; weakest: string | null }) {
  if (report.platforms.length === 0) return null;
  const unrun = report.platforms.filter((p) => {
    const r = report.rollup[p];
    return r && r.covered > r.ran;
  });
  return (
    <div className="grid w-full gap-1.5 sm:w-64" data-coverage-rollup>
      {report.platforms.map((p, i) => {
        const r = report.rollup[p];
        if (!r) return null;
        const label = PLATFORM_LABEL[p] ?? p;
        const pct = r.total ? (r.covered / r.total) * 100 : 0;
        const ran = r.total ? (Math.min(r.ran, r.covered) / r.total) * 100 : 0;
        const fail = r.total ? (Math.min(r.failing, r.ran) / r.total) * 100 : 0;
        const words =
          r.ran >= r.covered
            ? `${label}: scenarios cover ${r.covered} of ${r.total} areas, and every one of them ran on ${label}.`
            : `${label}: scenarios cover ${r.covered} of ${r.total} areas on paper; ${r.ran ? `${r.ran} of them` : "none of them"} ran on ${label} yet.`;
        return (
          <div key={p} className="grid grid-cols-[64px_1fr_auto] items-center gap-2 text-xs" data-coverage-platform={p} data-coverage-ran={r.ran} title={words} aria-label={words} role="img">
            <span className={cn("inline-flex items-center gap-1", weakest === p ? "text-[var(--cov-thin)]" : "text-fg-2")} aria-hidden>
              <PlatformIcon kind={p as TargetKind} className="size-3" />
              {label}
            </span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-panel-2" aria-hidden>
              {pct > ran ? (
                <span className={cn("absolute inset-y-0 left-0 rounded-full bg-[var(--cov-covered)] opacity-35", styles.barFill)} style={{ width: `${pct}%`, animationDelay: `${300 + i * 120}ms` }} />
              ) : null}
              <span className={cn("absolute inset-y-0 left-0 rounded-full bg-[var(--cov-covered)]", styles.barFill)} style={{ width: `${ran}%`, animationDelay: `${300 + i * 120}ms` }} />
              {fail > 0 ? (
                <span className={cn("absolute inset-y-0 rounded-full bg-[var(--cov-failing)]", styles.barFill)} style={{ left: `${ran - fail}%`, width: `${fail}%`, animationDelay: `${500 + i * 120}ms` }} />
              ) : null}
            </span>
            <span className="min-w-[44px] text-right tabular-nums text-muted" aria-hidden>
              {r.covered}/{r.total}
              {r.ran < r.covered ? <span className="text-2xs"> · {r.ran} ran</span> : null}
            </span>
          </div>
        );
      })}
      {unrun.length ? (
        <p className="text-right text-2xs text-muted" data-coverage-unrun>
          Faded: covered on paper, not run {unrun.length === 1 ? `on ${PLATFORM_LABEL[unrun[0]] ?? unrun[0]}` : "there"} yet.
        </p>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, attr }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; attr: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md px-2 text-sm transition-colors",
            value === o.value ? "bg-panel text-fg shadow-[var(--shadow-sm)]" : "text-fg-2 hover:text-fg",
          )}
          {...{ [attr]: o.value }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type CoverageView = "map" | "list" | "growth";

function ViewTabs({ view, onChange }: { view: CoverageView; onChange: (v: CoverageView) => void }) {
  return (
    <Segmented
      label="View"
      attr="data-coverage-view"
      value={view}
      onChange={onChange}
      options={[
        { value: "map", label: <><LayoutGrid className="size-3.5" />Map</> },
        { value: "list", label: <><List className="size-3.5" />List</> },
        { value: "growth", label: <><TrendingUp className="size-3.5" />Growth</>, title: "How coverage grew since the baseline" },
      ]}
    />
  );
}

/**
 * Scenarios > Coverage: "what is our test coverage?" per feature area. The headline sentence and
 * per-platform bars on top, the fog-of-war map (or the list, sorted by risk) below, and a side
 * panel for the area you click.
 */
export function CoverageBoard({ cid, projectName, scenarios, nonce, onScenario, initialView }: { cid: string; projectName: string; scenarios: readonly Scenario[]; nonce: number; onScenario: (id: string) => void; initialView?: string | null }) {
  const { auth, runQa } = useScenarios();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [stored, setStored] = useState<Stored | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformKey>("all");
  const [view, setView] = useState<CoverageView>(initialView === "list" || initialView === "growth" ? initialView : "map");
  const [selected, setSelected] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Once the map has been seen, coming back from the List shows it at once, not the fog again.
  const [startLifted, setStartLifted] = useState(false);
  const changeView = useCallback((v: CoverageView) => {
    if (v !== "map") setStartLifted(true);
    setView(v);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await loadStored(cid, signal);
        if (signal?.aborted) return false;
        setNow(Date.now());
        setStored(next);
        setError(null);
        return true;
      } catch (e) {
        if (signal?.aborted) return false;
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [cid],
  );

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load, nonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** A person's decision about which scenario tests this area: it survives every recompute. */
  async function decide(scenarioId: string, action: "confirm" | "reject") {
    if (!selected) return;
    setBusy(scenarioId);
    try {
      await setCoverageLink(cid, auth.human?.id ?? null, { action, scenario_id: scenarioId, feature_key: selected });
      await load();
      toast({ title: action === "confirm" ? "Linked to this area" : "Left out of this area" });
    } catch (err) {
      toast({ title: "Could not save that", description: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function recompute() {
    setRefreshing(true);
    const ok = await load();
    setRefreshing(false);
    if (ok) setReveal((n) => n + 1);
  }

  const report = useMemo<Coverage | null>(() => (stored ? computeCoverage({ ...stored, scenarios, now }) : null), [stored, scenarios, now]);
  const areas = useMemo(() => report?.areas ?? [], [report]);
  const counts = useMemo(() => stateCounts(areas, platform), [areas, platform]);
  const area = selected ? areas.find((a) => a.key === selected) : undefined;
  const platformOptions = useMemo(
    () => [
      { value: "all" as PlatformKey, label: "All" },
      ...(report?.platforms ?? []).map((p) => ({ value: p as PlatformKey, label: <><PlatformIcon kind={p as TargetKind} className="size-3" />{PLATFORM_LABEL[p] ?? p}</> })),
    ],
    [report],
  );

  if (view === "growth") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-coverage-scroll>
        <div className={cn(styles.palette, growthStyles.palette, "mx-auto w-full max-w-[1400px] px-4 py-5 md:px-6")} data-coverage-board data-coverage-growth>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ViewTabs view={view} onChange={changeView} />
          </div>
          <GrowthView project={{ id: cid, slug: cid, name: projectName }} nonce={nonce} onMapApp={() => runQa("map")} />
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-coverage-scroll>
        <div className={cn(styles.palette, "mx-auto w-full max-w-[1400px] px-4 py-5 md:px-6")}>
          {error ? (
            <div className="rounded-xl border border-border bg-panel p-6" data-coverage-error>
              <p className="text-base text-fg">Coverage could not be computed.</p>
              <p className="mt-1 text-sm text-muted">{error}</p>
              <Button className="mt-3" onClick={() => void recompute()}>
                <RefreshCw /> Try again
              </Button>
            </div>
          ) : (
            <CoverageLoading />
          )}
        </div>
      </div>
    );
  }

  const noFeatures = areas.length === 0;
  const noScenarios = !noFeatures && report.totals.scenarios === 0;
  const draftFirst = (
    <HumanGate>
      <Button variant="primary" size="lg" disabled={!auth.can} onClick={() => runQa("draft")} data-coverage-draft-first>
        <Sparkles /> Draft first scenarios
      </Button>
    </HumanGate>
  );

  return (
    // An open panel takes the right edge on desktop; the map makes room instead of hiding under it.
    <div className="min-h-0 flex-1 overflow-y-auto" data-coverage-scroll>
    <div className={cn(styles.palette, "mx-auto w-full max-w-[1400px] px-4 py-5 transition-[padding] duration-300 md:px-6", area && "md:pr-[424px]")} data-coverage-board>
      {noFeatures ? (
        <CoverageNoFeatures
          actions={
            <>
              <HumanGate>
                <Button variant="primary" size="lg" disabled={!auth.can} onClick={() => runQa("map")} data-coverage-scan>
                  <ScanSearch /> Map features from code
                </Button>
              </HumanGate>
              <HumanGate>
                <Button size="lg" disabled={!auth.can} onClick={() => runQa("explore")} data-coverage-explore>
                  <Compass /> Run a first exploration
                </Button>
              </HumanGate>
            </>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className={cn("min-w-0 max-w-3xl", styles.rise)}>
              <Headline text={report.headline} />
              <p className="mt-1 text-sm text-muted">
                {plural(report.totals.scenarios, "validated scenario")} across {plural(report.totals.areas, "feature area")}
                {sharedScenarios(report) ? ", and one scenario can count in more than one area" : ""}. Computed {ago(report.computed_at, now) || "just now"}.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
              <PlatformBars report={report} weakest={report.weakest} />
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            {report.platforms.length > 0 ? (
              <Segmented label="Platform" attr="data-coverage-platform-tab" value={platform} options={platformOptions} onChange={setPlatform} />
            ) : null}
            <ViewTabs view={view} onChange={changeView} />
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={() => void recompute()} aria-busy={refreshing} disabled={refreshing} data-coverage-recompute>
                <RefreshCw className={refreshing ? "animate-spin" : undefined} /> Recompute
              </Button>
            </div>
          </div>

          {view === "map" ? (
            <>
              <div className="relative">
              {refreshing ? <CoverageRecomputing prev={{ scenarios: report.totals.scenarios, links: report.totals.suggestions, areas: report.totals.areas }} /> : null}
              {noScenarios ? (
                <CoverageNoScenarios action={draftFirst}>
                  <CoverageMap areas={areas} platform={platform} selected={selected} onSelect={setSelected} reveal={reveal} fogAll startLifted={startLifted} />
                </CoverageNoScenarios>
              ) : (
                <CoverageMap areas={areas} platform={platform} selected={selected} onSelect={setSelected} reveal={reveal} startLifted={startLifted} />
              )}
              </div>
              <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-2" data-coverage-legend>
                {LEGEND.map((l) => (
                  <li key={l.state} className="inline-flex items-center gap-1.5" data-legend={l.state}>
                    <span className={cn("size-2.5 rounded-[3px]", l.state === "seen" ? "border border-dashed border-[var(--cov-untested)]" : l.state === "untested" ? "bg-[var(--cov-fog)] opacity-60" : STATE_DOT[l.state])} aria-hidden />
                    {l.label}
                    <span className="tabular-nums text-muted">{l.state === "untested" ? counts.untested - counts.seen : counts[l.state]}</span>
                  </li>
                ))}
                {report.unmapped_screens.length > 0 ? (
                  <li className="text-muted sm:ml-auto" title={report.unmapped_screens.map((s) => s.label).join(", ")}>
                    The map also has {plural(report.unmapped_screens.length, "screen")} no area claims.
                  </li>
                ) : null}
              </ul>
            </>
          ) : (
            <CoverageList report={report} platform={platform} onSelect={setSelected} selected={selected} now={now} />
          )}
        </>
      )}

      {area ? (
        <CoveragePanel area={area} report={report} platform={platform} now={now} onClose={() => setSelected(null)} onScenario={onScenario} onDecide={(id, action) => void decide(id, action)} busy={busy} />
      ) : null}
    </div>
    </div>
  );
}

function CoverageList({ report, platform, onSelect, selected, now }: { report: Coverage; platform: PlatformKey; onSelect: (key: string) => void; selected: string | null; now: number }) {
  const rows = riskSorted(report.areas, platform);
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-panel" data-coverage-list>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.08em] text-muted">
            <th className="w-10 px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Area</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 text-right font-medium">Scenarios</th>
            <th className="px-3 py-2 text-right font-medium">Depth</th>
            {report.platforms.map((p) => (
              <th key={p} className="px-3 py-2 text-center font-medium">
                {PLATFORM_LABEL[p] ?? p}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Last run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => {
            const s = stateOn(a, platform);
            const d = a.depths[platform] ?? a.depth;
            return (
              <tr
                key={a.key}
                className={cn("cursor-pointer border-b border-border last:border-0 hover:bg-hover", selected === a.key && "bg-selected", styles.rise)}
                style={{ "--i": Math.min(i, 12) } as CSSProperties}
                onClick={() => onSelect(a.key)}
                data-coverage-row={a.key}
                data-state={s}
              >
                <td className="px-3 py-2 tabular-nums text-muted">{i + 1}</td>
                <td className="max-w-[260px] px-3 py-2">
                  <button type="button" className="truncate text-left font-medium text-fg hover:underline" onClick={() => onSelect(a.key)}>
                    {a.name}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-fg-2">
                    <span className={cn("size-2 rounded-full", STATE_DOT[s], s !== "untested" && !ranOn(a, platform) && "opacity-40")} aria-hidden />
                    {stateWords(a, platform)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{d.scenarios}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.score.toFixed(1)}</td>
                {report.platforms.map((p) => {
                  const r = a.last[p];
                  return (
                    <td key={p} className="px-3 py-2 text-center">
                      <span
                        className={cn("inline-block size-2 rounded-full", r ? (r.outcome === "pass" ? "bg-success" : "bg-danger") : "bg-border-strong")}
                        title={r ? `${r.outcome === "pass" ? "Passed" : "Failed"} ${ago(r.at, now)}` : "Not run"}
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-xs text-muted">{a.last_result_at ? ago(a.last_result_at, now) : "Never"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
