import { useState, type CSSProperties, type MutableRefObject } from "react";
import { Maximize2 } from "../map/kit/icons";
import { Button } from "./ui";
import { cn } from "./ui";
import type { Plan } from "./choreo";
import type { OnboardingMap } from "./contract";
import { coverageCounts, coverageSentence, coveringFrameworks, gapPlatform, yourTestsPhrase } from "./coverage";
import { platformWord } from "../qaWords";
import { MapStage } from "./map-stage";
import { TeachingState } from "./scenes";
import styles from "./onboarding-map.module.css";

const d = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

/** The three colours, named once, with their counts. */
export function CoverageLegend({ map }: { map: OnboardingMap }) {
  const c = coverageCounts(map.screens);
  const fws = coveringFrameworks(map.screens).map((f) => f.framework);
  const items = [
    { cls: styles.yours, label: yourTestsPhrase(fws).replace(/^your /, "Your "), n: c.yours + c.both, key: "yours" },
    { cls: styles.qa, label: "Embodent", n: c.qa + c.both, key: "qa" },
    { cls: styles.none, label: "Not covered", n: c.none, key: "none" },
  ];
  return (
    <ul className={cn(styles.tones, "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2")} aria-label="Legend" data-onboarding-legend>
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5" data-legend={it.key}>
          <span className={cn(it.cls, styles.swatch)} aria-hidden />
          {it.label}
          <span className="tabular-nums text-muted">{it.n}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className={cn(styles.code, styles.swatch)} data-dashed="true" aria-hidden />
        Dashed: known from the code only
      </li>
    </ul>
  );
}

/**
 * The coverage picture: the same map in three colours with a legend, the plain counts, and
 * the gaps riskiest first with their reasons. A gap clicked (or chosen with the keyboard)
 * glides the map onto its screen.
 */
export function CoverageStep({ map, planRef }: { map: OnboardingMap; planRef: MutableRefObject<Plan | null> }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const parts = coverageSentence(map);
  const byId = new Map(map.screens.map((s) => [s.id, s]));
  const gaps = map.gaps.filter((g) => byId.has(g.screen_id));

  if (map.screens.length === 0) {
    return (
      <TeachingState scene="coverage" title="No screens to show yet">
        Coverage appears once the map has found screens: teal for what your tests reach, indigo for what Embodent checks, amber for what nothing does.
      </TeachingState>
    );
  }

  function pick(id: string) {
    setFocus(id);
    setZoom(id);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-lg font-semibold tracking-[-0.01em] text-fg" data-onboarding-coverage-sentence>
        {parts.map((p, i) => (
          <span key={p} className={styles.rise} style={d(i * 90)}>
            {i > 0 ? <span className="mx-1.5 font-normal text-muted">·</span> : null}
            <span className={i === parts.length - 1 && map.summary.untested_critical.length ? "text-warning" : undefined}>{p}</span>
          </span>
        ))}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CoverageLegend map={map} />
        {zoom ? (
          <Button size="sm" variant="ghost" onClick={() => setZoom(null)} data-onboarding-show-all>
            <Maximize2 aria-hidden /> Show the whole map
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <MapStage
          map={map}
          planRef={planRef}
          mode="coverage"
          label={`Coverage map: ${parts.join(", ")}`}
          focusId={focus}
          onFocusChange={setFocus}
          onSelect={pick}
          zoomTo={zoom}
        />
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-panel" aria-labelledby="onb-gaps-title">
          <header className="border-b border-border px-3 py-2.5">
            <h2 id="onb-gaps-title" className="text-sm font-semibold text-fg">
              Gaps, riskiest first
            </h2>
            <p className="text-xs text-muted">{gaps.length ? `${gaps.length} screens nothing tests. Pick one to find it on the map.` : "Nothing is left uncovered."}</p>
          </header>
          {gaps.length ? (
            <ol className="flex max-h-[520px] flex-col overflow-y-auto p-1.5" data-onboarding-gaps>
              {gaps.map((g, i) => {
                const s = byId.get(g.screen_id)!;
                const on = focus === g.screen_id;
                const where = gapPlatform(g.screen_id, map.gaps.map((x) => x.screen_id));
                return (
                  <li key={g.screen_id}>
                    <button
                      type="button"
                      onClick={() => pick(g.screen_id)}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                        on ? "bg-selected" : "hover:bg-hover",
                      )}
                      data-onboarding-gap={g.screen_id}
                    >
                      <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                          {where ? <span className="shrink-0 text-xs text-muted">{platformWord(where)}</span> : null}
                          {g.flow ? <span className="shrink-0 text-xs text-muted">{g.flow}</span> : null}
                        </span>
                        <span className="block text-xs text-fg-2">{g.reason}</span>
                      </span>
                      <span className="mt-1.5 h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border" aria-label={`Risk ${Math.round(g.risk * 100)} of 100`} role="img">
                        <span className={cn(styles.tones, "block h-full rounded-full bg-[color:var(--c-none)]")} style={{ width: `${Math.max(8, Math.round(g.risk * 100))}%` }} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <TeachingState scene="coverage" title="Every screen is covered" className="py-6" />
          )}
        </section>
      </div>
    </div>
  );
}
