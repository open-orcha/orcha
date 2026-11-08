import { useMemo, useState, type MutableRefObject } from "react";
import { Link } from "./ui";
import { ArrowRight, CheckCircle2, ChevronDown, FileCode2, Sparkles } from "../map/kit/icons";
import { Button } from "./ui";
import { useWithReturn } from "./ui";
import { cn } from "./ui";
import type { Plan } from "./choreo";
import { costWords, frameworkName, settled, subscriptionWords, usd, type BringInOptions, type MapAction, type OnboardingMap } from "./contract";
import { areaOf, bringInCount } from "./coverage";
import { MapStage } from "./map-stage";
import { TeachingState } from "./scenes";
import styles from "./onboarding-map.module.css";

const scenarioHref = (_slug: string, id: string) => `/qa?view=scenarios&scenario=${encodeURIComponent(id)}`;

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The tests the map matched in the chosen frameworks and areas (narrowed bring-in count). */
export function narrowedTests(map: OnboardingMap, frameworks: ReadonlySet<string>, areas: ReadonlySet<string>): number {
  const seen = new Set<string>();
  for (const s of map.screens) {
    if (!areas.has(areaOf(s))) continue;
    for (const t of s.tests) if (frameworks.has(t.framework)) seen.add(`${t.path}#${t.name}`);
  }
  return seen.size;
}

/**
 * Bring it in: one primary button brings every existing test in as a pointer (free, nothing
 * runs, the code stays in the repository), with the per-framework and per-area choice folded
 * under it; a second, paid action drafts scenarios for the untested flows, its estimate on the
 * button. Drafts land on their screens and are reviewed from the list beside the map.
 */
export function BringInStep({
  map,
  slug,
  planRef,
  busy,
  onAct,
}: {
  map: OnboardingMap;
  slug: string;
  planRef: MutableRefObject<Plan | null>;
  busy: MapAction | null;
  onAct: (action: MapAction, options: BringInOptions) => void;
}) {
  const withReturn = useWithReturn();
  const fwAll = useMemo(() => map.bring_in.migrate.map((m) => m.framework), [map.bring_in.migrate]);
  const areaAll = useMemo(() => {
    const by = new Map<string, number>();
    for (const s of map.screens) if (s.tests.length) by.set(areaOf(s), (by.get(areaOf(s)) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  }, [map.screens]);
  const [fws, setFws] = useState<Set<string> | null>(null);
  const [areas, setAreas] = useState<Set<string> | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pressed, setPressed] = useState<"tests" | "draft" | null>(null);

  const total = bringInCount(map, null);
  const narrowed = fws !== null || areas !== null;
  const count = narrowed ? narrowedTests(map, fws ?? new Set(fwAll), areas ?? new Set(areaAll.map(([a]) => a))) : total;
  const gapIds = map.bring_in.draft.gap_screen_ids;
  const phase = map.phases.bring_in;
  // Bringing tests in is no agent run: it happens in the click, for free. Only drafting is a run.
  const importing = (pressed === "tests" && busy === "bring_in") || (phase.state === "running" && !phase.task_id && pressed !== "draft");
  const running = phase.state === "running" && !importing;
  const done = settled(phase);
  // Imported tests come in as drafts too: a scenario on a gap screen (nothing tested it) is a
  // draft for the gap, the rest came from your tests, unless the backend names the origin.
  const gapSet = new Set(gapIds);
  const isGapDraft = (screenId: string, x: { origin?: string; status: string }) => (x.origin ? x.origin === "drafted" : gapSet.has(screenId) && x.status === "draft");
  const drafts = map.screens.flatMap((s) => s.scenarios.filter((x) => x.status === "draft").map((x) => ({ ...x, screen: s, gap: isGapDraft(s.id, x) })));
  const gapDrafts = new Set(drafts.filter((x) => x.gap).map((x) => x.id)).size;
  // The phase's own count lands with the click; the map's rows follow on the next read.
  const imported = phase.counts?.imported ?? new Set(map.screens.flatMap((s) => s.scenarios.filter((x) => (x.origin ? x.origin === "imported" : !isGapDraft(s.id, x))).map((x) => x.id))).size;
  // One row per scenario (a test that reaches several screens is listed once), or the selected screen's.
  const listed = selected ? drafts.filter((x) => x.screen.id === selected) : drafts.filter((x, i) => drafts.findIndex((y) => y.id === x.id) === i);

  function toggle(set: Set<string> | null, all: string[], key: string, apply: (s: Set<string>) => void) {
    const next = new Set(set ?? all);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  }

  const narrowing = (): Pick<BringInOptions, "frameworks" | "areas"> => ({ ...(fws ? { frameworks: [...fws] } : {}), ...(areas ? { areas: [...areas] } : {}) });

  return (
    <div className="flex flex-col gap-4">
      {total > 0 && !done && !running && !importing ? (
        <section className="rounded-xl border border-primary/30 bg-primary/5 p-4" data-onboarding-bring-tests>
          <div className="flex flex-wrap items-center gap-3">
            <FileCode2 className="size-5 shrink-0 text-primary" strokeWidth={1.6} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg">
                {map.bring_in.migrate.map((m) => `${m.count} ${frameworkName(m.framework)}`).join(" · ")}
              </p>
              <p className="text-xs text-muted">They come in as pointers: each scenario points at the test, and its code stays in your repository. Free; nothing runs.</p>
            </div>
            <Button
              variant="primary"
              size="lg"
              disabled={count === 0 || busy === "bring_in"}
              onClick={() => {
                setPressed("tests");
                onAct("bring_in", { migrate: true, draft: false, ...narrowing() });
              }}
              data-onboarding-bring-all
            >
              {narrowed ? `Bring ${count} of ${total} tests in` : `Bring all ${total} tests in`}
            </Button>
          </div>
          <button
            type="button"
            className="mt-2 flex items-center gap-1 text-xs text-fg-2 hover:text-fg"
            aria-expanded={open}
            aria-controls="onb-bring-choose"
            onClick={() => setOpen((o) => !o)}
            data-onboarding-bring-choose
          >
            <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
            Choose by framework or area
          </button>
          {open ? (
            <div id="onb-bring-choose" className="mt-2 grid gap-4 sm:grid-cols-2">
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-muted">Frameworks</legend>
                {map.bring_in.migrate.map((m) => (
                  <label key={m.framework} className="flex items-center gap-2 py-0.5 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--color-primary)]"
                      checked={(fws ?? new Set(fwAll)).has(m.framework)}
                      onChange={() => toggle(fws, fwAll, m.framework, setFws)}
                    />
                    {frameworkName(m.framework)} <span className="text-xs tabular-nums text-muted">{m.count}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-muted">Areas</legend>
                {areaAll.map(([a, n]) => (
                  <label key={a} className="flex items-center gap-2 py-0.5 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-[var(--color-primary)]"
                      checked={(areas ?? new Set(areaAll.map(([k]) => k))).has(a)}
                      onChange={() => toggle(areas, areaAll.map(([k]) => k), a, setAreas)}
                    />
                    {titleCase(a)} <span className="text-xs tabular-nums text-muted">{n} {n === 1 ? "screen" : "screens"}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : null}
        </section>
      ) : null}

      {total === 0 && !done && !running ? (
        <TeachingState scene="bring_in" title="No existing tests to bring in" className="rounded-xl border border-border bg-panel py-6">
          Tests you already have would come in as pointers to their code. This repository has none Embodent can read, so drafting is where to start.
        </TeachingState>
      ) : null}

      {gapIds.length > 0 && gapDrafts === 0 && !running && !importing ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-panel p-4" data-onboarding-bring-draft>
          <Sparkles className="size-5 shrink-0 text-fg-2" strokeWidth={1.6} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">{gapIds.length === 1 ? "Draft a scenario for the untested flow" : `Draft scenarios for the ${gapIds.length} untested flows`}</p>
            <p className="text-xs text-muted">
              Embodent reads the code behind each gap and writes a scenario for you to review.{" "}
              {map.billing.draft ? `${subscriptionWords(map.billing, "draft", map.bring_in.draft.estimate_usd)}.` : map.bring_in.draft.estimate_usd > 0 ? `About ${usd(map.bring_in.draft.estimate_usd)}.` : "It runs as a task for your agent."}
            </p>
          </div>
          <Button
            variant={total === 0 || done ? "primary" : "default"}
            loading={busy === "bring_in" && pressed === "draft"}
            onClick={() => {
              setPressed("draft");
              onAct("bring_in", { migrate: false, draft: true, gap_screen_ids: gapIds });
            }}
            data-onboarding-draft-gaps
          >
            Draft for {gapIds.length} {gapIds.length === 1 ? "gap" : "gaps"}{map.billing.draft || map.bring_in.draft.estimate_usd > 0 ? ` · ${costWords(map.billing, "draft", map.bring_in.draft.estimate_usd)}` : ""}
          </Button>
        </section>
      ) : null}

      {importing ? (
        <p className={cn(styles.beat, "flex items-center gap-2 text-sm text-fg")} role="status" data-onboarding-bring-state="importing">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {count} {count === 1 ? "test" : "tests"} coming in. Free; nothing runs.
        </p>
      ) : running || done ? (
        <p className={cn(styles.beat, "flex items-center gap-2 text-sm text-fg")} role="status" data-onboarding-bring-state={phase.state}>
          {done ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <span className="size-3 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent motion-reduce:animate-none" aria-hidden />}
          {done
            ? `${phase.note?.replace(/\.+$/, "") ?? `${imported} ${imported === 1 ? "test" : "tests"} brought in, ${gapDrafts} drafted for the gaps`}. They wait on their screens for review.`
            : `Drafting for the gaps${imported ? ` · ${imported} ${imported === 1 ? "test" : "tests"} in` : ""}${gapDrafts ? ` · ${gapDrafts} drafted` : ""}`}
          {phase.cost_usd && !map.billing.draft ? <span className="text-xs text-muted">{usd(phase.cost_usd)}</span> : null}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <MapStage
          map={map}
          planRef={planRef}
          mode="bring_in"
          label="Map with drafts on their screens"
          focusId={selected}
          onFocusChange={setSelected}
          onSelect={setSelected}
        />
        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-panel" aria-labelledby="onb-drafts-title">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <h2 id="onb-drafts-title" className="truncate text-sm font-semibold text-fg">
                {selected ? `On ${map.screens.find((s) => s.id === selected)?.name ?? "this screen"}` : "Drafts to review"}
              </h2>
              <p className="text-xs text-muted">{drafts.length ? "Each sits on the screen it checks. Open one to review it." : "Drafts land here and on their screens."}</p>
            </div>
            {selected ? (
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                All
              </Button>
            ) : null}
          </header>
          {listed.length ? (
            <ul className="flex max-h-[520px] flex-col overflow-y-auto p-1.5" data-onboarding-drafts>
              {listed.map((x) => (
                <li key={`${x.screen.id}:${x.id}`}>
                  <Link
                    href={withReturn(scenarioHref(slug, x.id))}
                    className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-hover"
                    onMouseEnter={() => setSelected(x.screen.id)}
                    data-onboarding-draft={x.id}
                  >
                    <span className={cn(styles.tones, styles.qa, styles.swatch, "mt-1")} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{x.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {x.screen.name} · {x.gap ? "drafted for a gap" : "from your tests"}
                      </span>
                    </span>
                    <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-sm text-muted">{running ? "Drafting…" : selected ? "No drafts on this screen." : "None yet."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
