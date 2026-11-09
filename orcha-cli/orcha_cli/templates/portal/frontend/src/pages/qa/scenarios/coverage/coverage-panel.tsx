
import type { CSSProperties, ReactNode } from "react";
import { Check, Compass, Crosshair, Map as MapIcon, Sparkles, X } from "../../map/kit/icons";
import { Button, Link, PlatformIcon, cn, type TargetKind } from "../../map/kit";
import { qaHref } from "../../parts";
import { HumanGate, useScenarios } from "../context";
import { ago, areaPanel, type ScenarioRow } from "./panel-model";
import styles from "../../map/coverage.module.css";
import type { Coverage, CoverageArea, CoverageState, PlatformKey } from "./types";

export const STATE_DOT: Record<CoverageState, string> = {
  strong: "bg-[var(--cov-strong)]",
  covered: "bg-[var(--cov-covered)]",
  thin: "bg-[var(--cov-thin)]",
  failing: "bg-[var(--cov-failing)]",
  untested: "bg-transparent border border-dashed border-[var(--cov-untested)]",
};

function Section({ title, children, i }: { title: string; children: ReactNode; i: number }) {
  return (
    <section className={cn("border-t border-border px-4 py-3", styles.rise)} style={{ "--i": i } as CSSProperties}>
      <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.1em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function ScenarioLine({ row, onOpen, children }: { row: ScenarioRow; onOpen: (id: string) => void; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-2 py-1.5" data-coverage-scenario={row.id}>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => onOpen(row.id)} className="block max-w-full truncate text-left text-base text-fg hover:underline">
          {row.name}
          {row.draft ? <span className="ml-1.5 rounded border border-border px-1 text-2xs text-muted">Draft</span> : null}
          {row.paused ? (
            <span className="ml-1.5 rounded border border-info/30 bg-info/10 px-1 text-2xs text-info" title={`Paused: ${row.paused}. Keeps its coverage; skipped by runs until it resumes.`} data-coverage-paused>
              Paused
            </span>
          ) : null}
        </button>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <span>{row.source}</span>
          {row.platforms.map((p) => (
            <span key={p.platform} className={cn("inline-flex items-center gap-0.5", p.outcome === "pass" ? "text-success" : "text-danger")} title={`${p.outcome === "pass" ? "Passed" : "Failed"} on ${p.platform}`}>
              <PlatformIcon kind={p.platform as TargetKind} className="size-3" />
              {p.outcome === "pass" ? "✓" : "✕"}
            </span>
          ))}
        </div>
      </div>
      {children}
    </li>
  );
}

/**
 * The side panel for one area: its state and sentence, last result per platform, the scenarios
 * linked to it, how deep it is tested, what explorations saw there, and "Draft scenarios for this
 * area" (opens Run check; nothing runs until Start is clicked there).
 */
export function CoveragePanel({
  area,
  report,
  platform,
  now,
  onClose,
  onScenario,
  onDecide,
  busy,
}: {
  area: CoverageArea;
  report: Coverage;
  platform: PlatformKey;
  now: number;
  onClose: () => void;
  onScenario: (id: string) => void;
  onDecide: (scenarioId: string, action: "confirm" | "reject") => void;
  busy: string | null;
}) {
  const { auth, runQa } = useScenarios();
  const p = areaPanel(area, report, platform, now);
  return (
    <aside
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 max-h-[82vh] overflow-y-auto rounded-t-xl border border-border bg-panel shadow-[var(--shadow-md)] md:inset-x-auto md:bottom-3 md:right-3 md:top-3 md:max-h-none md:w-[400px] md:rounded-xl",
        styles.panel,
      )}
      aria-label={`${area.name} coverage`}
      data-coverage-panel={area.key}
    >
      <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-border bg-panel/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("size-2.5 shrink-0 rounded-full", STATE_DOT[p.state])} aria-hidden />
            <h2 className="truncate text-lg font-semibold text-fg">{p.name}</h2>
          </div>
          <div className="mt-0.5 text-sm text-fg-2" data-coverage-panel-state={p.state}>
            {p.stateLabel}
          </div>
        </div>
        <Button variant="ghost" size="md" icon onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </header>

      <div className={cn("px-4 py-3", styles.rise)}>
        <p className="text-base text-fg">{p.sentence}</p>
        {area.summary ? <p className="mt-1 text-sm text-muted">{area.summary}</p> : null}
        {area.entry || area.paths.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {[area.entry, ...area.paths.slice(0, 3)].filter(Boolean).map((x) => (
              <code key={x} className="max-w-full truncate rounded bg-panel-2 px-1.5 py-0.5 font-mono text-2xs text-fg-2">
                {x}
              </code>
            ))}
          </div>
        ) : null}
        <HumanGate>
          <Button variant={p.state === "untested" || p.state === "thin" ? "primary" : "default"} size="lg" disabled={!auth.can} className="mt-3 w-full" onClick={() => runQa("draft")} data-coverage-draft>
            <Sparkles /> Draft scenarios for this area
          </Button>
        </HumanGate>
        {area.map ? (
          <p className="mt-2 text-sm text-fg-2" data-coverage-map={`${area.map.covered}/${area.map.screens}`}>
            {area.map.covered} of {area.map.screens} screen{area.map.screens === 1 ? "" : "s"} on the map covered by a scenario
            {area.map.uncovered.length ? <span className="text-muted">; not yet: {area.map.uncovered.slice(0, 3).join(", ")}</span> : null}.
          </p>
        ) : null}
        <Link href={qaHref({ view: "map", feature: area.key })} className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline" data-coverage-open-map>
          <MapIcon className="size-3.5" aria-hidden /> Open in Map
        </Link>
      </div>

      {report.platforms.length > 0 ? (
        <Section title="Latest result" i={1}>
          <ul className="grid gap-1.5">
            {p.platforms.map((r) => (
              <li key={r.platform} className="flex items-center gap-2 text-sm" data-coverage-platform-result={r.platform} data-outcome={r.outcome}>
                <PlatformIcon kind={r.platform as TargetKind} className="size-3.5 text-fg-2" />
                <span className="w-16 text-fg-2">{r.label}</span>
                <span className={cn("size-1.5 rounded-full", r.outcome === "pass" ? "bg-success" : r.outcome === "fail" ? "bg-danger" : "bg-border-strong")} aria-hidden />
                <span className={r.outcome === "none" ? "text-muted" : "text-fg"}>{r.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={`Scenarios (${p.linked.length})`} i={2}>
        {p.linked.length ? (
          <ul className="-my-1.5 divide-y divide-border" data-coverage-linked>
            {p.linked.map((row) => (
              <ScenarioLine key={row.id} row={row} onOpen={onScenario} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No scenario is linked yet.</p>
        )}
      </Section>

      {p.suggestions.length ? (
        <Section title={`Might test this (${p.suggestions.length})`} i={3}>
          <ul className="-my-1.5 divide-y divide-border" data-coverage-suggestions>
            {p.suggestions.map((row) => (
              <ScenarioLine key={row.id} row={row} onOpen={onScenario}>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => onDecide(row.id, "confirm")} aria-busy={busy === row.id} disabled={busy !== null || !auth.can} data-coverage-confirm={row.id}>
                    <Check /> Yes
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDecide(row.id, "reject")} disabled={busy !== null || !auth.can} aria-label={`Not this area: ${row.name}`} data-coverage-reject={row.id}>
                    <X />
                  </Button>
                </div>
              </ScenarioLine>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Depth" i={3}>
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
            <div className={cn("h-full rounded-full bg-[var(--cov-covered)]", styles.barFill)} style={{ width: `${Math.max(2, p.depth.score * 10)}%` }} />
          </div>
          <span className="text-sm tabular-nums text-fg" data-coverage-depth>
            {p.depth.score.toFixed(1)}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">{p.depth.facts.join(" · ")}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {p.depth.edges.map((e) => (
            <span
              key={e.key}
              className={cn("rounded-full border px-2 py-0.5 text-2xs", e.tested ? "border-[var(--cov-covered)] text-fg" : "border-dashed border-border text-muted")}
              data-edge={e.key}
              data-tested={e.tested ? "true" : "false"}
            >
              {e.tested ? "✓ " : ""}
              {e.label}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Explored" i={4}>
        {p.explored.screens.length || p.explored.at ? (
          <>
            <p className="flex items-center gap-1.5 text-sm text-fg-2">
              <Compass className="size-3.5" />
              {p.explored.at ? `Explored ${ago(p.explored.at, now)}` : `Seen on ${p.explored.screens.length} screens`}
            </p>
            {p.explored.screens.length ? (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {p.explored.screens.map((s) => (
                  <li key={s} className="max-w-full truncate rounded bg-panel-2 px-1.5 py-0.5 font-mono text-2xs text-fg-2">
                    {s}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Crosshair className="size-3.5" /> No exploration has been here yet.
          </p>
        )}
        <HumanGate>
          <button type="button" disabled={!auth.can} onClick={() => runQa("explore")} className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline disabled:opacity-50" data-coverage-explore-area>
            <Compass className="size-3.5" aria-hidden /> Explore this area
          </button>
        </HumanGate>
      </Section>
    </aside>
  );
}
