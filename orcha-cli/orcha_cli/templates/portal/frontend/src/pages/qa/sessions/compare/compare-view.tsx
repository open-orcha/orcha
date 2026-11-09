import { Link } from "../../map/kit";
import { useRouter } from "../../map/kit";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, CircleCheck, CircleDashed, CirclePlus, Columns2, RefreshCcw } from "../../map/kit/icons";
import { SeverityTag } from "../../map/kit";
import { Select } from "../../map/kit";
import { compareResults, notComparableReason, type CountDelta, type ExplorationComparison } from "../compare/exploration-compare";
import { shortDate, STATUS_LABEL, type Exploration, type ResultFinding, type TargetKind } from "../explorations";
import { PLATFORM_LABELS as PLATFORM_NAMES } from "../../map/kit";
import { cn } from "../../map/kit";
import { GRADE_STROKE, gradeFor, ScoreRing } from "../score-ring";
import { LensChip, lensLabel } from "../lens-chip";
import { RecipeMeta } from "../recipe-meta";
import { compareHref, explorationHref } from "../links";
import styles from "../motion.module.css";

export interface CompareSide {
  exploration: Exploration;
  /** The build it ran on ("1.4.2 (88)"), when its request had one. */
  build: string | null;
}

export interface CompareOption {
  id: string;
  name: string;
  created_at: string;
  scored: boolean;
}

function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function Delta({ value, invert = false, className }: { value: number | null; invert?: boolean; className?: string }) {
  if (value == null) return <span className={cn("text-xs text-muted", className)}>-</span>;
  const good = invert ? value < 0 : value > 0;
  return (
    <span className={cn("text-xs font-medium tabular", value === 0 ? "text-muted" : good ? "text-success" : "text-danger", className)}>
      {value === 0 ? "no change" : signed(value)}
    </span>
  );
}

function SideHeader({ side, label, other, options }: { side: CompareSide; label: string; other: string; options: CompareOption[] }) {
  const router = useRouter();
  const e = side.exploration;
  const platform = e.platform && e.platform in PLATFORM_NAMES ? PLATFORM_NAMES[e.platform as TargetKind] : null;
  const choices = options.filter((o) => o.id !== other);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-panel p-3" data-compare-side={label}>
      <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted">{label}</span>
      <Link href={explorationHref(e.id)} className="truncate text-base font-semibold text-fg hover:underline hover:underline-offset-2">
        {e.name}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
        <time dateTime={e.created_at}>{shortDate(e.created_at)}</time>
        <RecipeMeta recipe={e.recipe} minutes={e.minutes} size="sm" />
        {platform ? <span>{platform}</span> : null}
        {side.build ? <span className="font-mono">{side.build}</span> : null}
        {e.status !== "done" ? <span>{STATUS_LABEL[e.status]}</span> : null}
      </div>
      {choices.length > 0 ? (
        <Select
          dimension="sm"
          aria-label={`Pick another exploration as ${label}`}
          value={e.id}
          icon={<RefreshCcw className="size-3" />}
          onValueChange={(id) => {
            if (id && id !== e.id) router.push(label === "Before" ? compareHref(id, other) : compareHref(other, id));
          }}
          options={[{ value: e.id, label: e.name, hidden: true }, ...choices.map((o) => ({ value: o.id, label: o.name, description: shortDate(o.created_at), disabled: !o.scored, disabledReason: o.scored ? undefined : "no result" }))]}
          wrapperClassName="mt-1"
          data-compare-switch={label}
        />
      ) : null}
    </div>
  );
}

/** One lens: B's bar grows from A's value to B's, with A marked on the track. */
function LensBar({ row, index }: { row: ExplorationComparison["lenses"][number]; index: number }) {
  // Starts at A on the server and the first client render (no hydration mismatch), then moves.
  const [width, setWidth] = useState(row.a ?? 0);
  useEffect(() => {
    const t = setTimeout(() => setWidth(row.b ?? 0), reducedMotion() ? 0 : 120 + index * 80);
    return () => clearTimeout(t);
  }, [row.b, index]);
  const grade = row.gradeB ?? gradeFor(row.b);
  const label = `${lensLabel(row.lens)}: ${row.a == null ? "not looked at before" : row.a} to ${row.b == null ? "not looked at now" : row.b}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_72px] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)_72px]" aria-label={label} data-compare-lens={row.lens}>
      <LensChip lens={row.lens} size="sm" className="justify-self-start" />
      <div className="relative h-2.5 rounded-full bg-border/60 max-sm:order-last max-sm:col-span-2" aria-hidden>
        {row.b != null ? (
          <span className={cn("absolute inset-y-0 left-0 rounded-full", styles.bar)} style={{ width: `${width}%`, background: GRADE_STROKE[grade] }} />
        ) : null}
        {row.a != null ? <span className="absolute -inset-y-1 w-0.5 rounded bg-fg/60" style={{ left: `calc(${row.a}% - 1px)` }} title={`Before: ${row.a}`} /> : null}
      </div>
      <span className="text-right tabular text-sm text-fg">
        {row.b ?? "-"} <Delta value={row.delta} className="ml-1" />
      </span>
    </li>
  );
}

function FindingList({ title, icon, items, href, empty, tone }: { title: string; icon: ReactNode; items: ResultFinding[]; href: string; empty: string; tone: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-panel p-3" aria-label={`${title}: ${items.length}`} data-compare-column={title}>
      <h3 className={cn("flex items-center gap-1.5 text-sm font-semibold", tone)}>
        {icon}
        {title}
        <span className="ml-auto text-xs font-normal tabular text-muted">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((f, i) => (
            <li key={f.fingerprint} className={styles.columnItem} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
              <Link href={`${href}#finding-${f.fingerprint}`} className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 hover:bg-hover" data-compare-finding={f.fingerprint}>
                <SeverityTag severity={f.severity} className="mt-px" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-fg">{f.title}</span>
                  <span className="text-[11px] text-muted">
                    {lensLabel(f.lens)}
                    {f.screen ? ` · ${f.screen}` : f.feature ? ` · ${f.feature}` : ""}
                    {f.source === "measured" ? " · measured" : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, d, invert = false }: { label: string; d: CountDelta; invert?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-panel px-3 py-2" data-compare-stat={label}>
      <span className="text-[11px] text-muted">{label}</span>
      <span className="flex items-baseline gap-1.5 text-sm tabular text-fg">
        {d.a} <ArrowRight aria-label="to" className="size-3 self-center text-muted" /> {d.b}
        <Delta value={d.delta} invert={invert} />
      </span>
    </div>
  );
}

/**
 * Compare two explorations: the two side by side, the score and each lens moving
 * from before to after, findings fixed, new and still there, and how coverage moved. A pair
 * where one has no result yet (a legacy report, a run still going) says so plainly.
 */
export function CompareView({ a, b, options }: { a: CompareSide; b: CompareSide; options: CompareOption[] }) {
  const reason = notComparableReason(a.exploration, b.exploration);
  const c = !reason && a.exploration.result && b.exploration.result ? compareResults(a.exploration.result, b.exploration.result) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-5 py-5 max-[720px]:px-4" data-compare>
      <header className="flex items-center gap-2">
        <Columns2 aria-hidden className="size-4 text-muted" />
        <h1 className="text-lg font-semibold text-fg">Compare explorations</h1>
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SideHeader side={a} label="Before" other={b.exploration.id} options={options} />
        <SideHeader side={b} label="After" other={a.exploration.id} options={options} />
      </div>

      {!c ? (
        <div className="v-rise flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center" data-compare-not-comparable>
          <CircleDashed aria-hidden className="size-6 text-muted" />
          <h2 className="text-sm font-semibold text-fg">Not comparable yet</h2>
          <p className="max-w-[480px] text-sm text-fg-2">{reason}</p>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4 sm:flex-row sm:items-center" aria-label="Score">
            <div className="flex items-center gap-4">
              <ScoreRing score={c.score.a} size={64} label="Score before" />
              <ArrowRight aria-hidden className="size-4 text-muted" />
              <ScoreRing score={c.score.b} size={64} delta={c.score.delta} label="Score after" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-base font-medium text-fg" data-compare-score-delta>
                {c.score.delta === 0 ? "Same score." : c.score.delta > 0 ? `Up ${c.score.delta} points.` : `Down ${-c.score.delta} points.`}
              </p>
              <p className="text-sm text-fg-2">
                {c.fixed.length} fixed, {c.added.length} new, {c.persisting.length} still there.
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-2.5" aria-labelledby="compare-lenses">
            <h2 id="compare-lenses" className="text-sm font-semibold text-fg">
              By lens
            </h2>
            <ul className="flex flex-col gap-2.5 rounded-lg border border-border bg-panel p-4">
              {c.lenses.map((row, i) => (
                <LensBar key={row.lens} row={row} index={i} />
              ))}
            </ul>
            <p className="text-xs text-muted">The bar is after; the mark is before.</p>
          </section>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FindingList title="Fixed" icon={<CircleCheck className="size-4" />} tone="text-success" items={c.fixed} href={explorationHref(a.exploration.id)} empty="Nothing fixed between these two." />
            <FindingList title="New" icon={<CirclePlus className="size-4" />} tone="text-danger" items={c.added} href={explorationHref(b.exploration.id)} empty="Nothing new. Good." />
            <FindingList title="Still there" icon={<CircleDashed className="size-4" />} tone="text-fg" items={c.persisting} href={explorationHref(b.exploration.id)} empty="Nothing carried over." />
          </div>
          {c.unchecked.length > 0 ? (
            <p className="text-xs text-muted">
              {c.unchecked.length} earlier finding{c.unchecked.length === 1 ? "" : "s"} on screens or lenses the later run did not reach, so it cannot say whether they are fixed.
            </p>
          ) : null}

          <section className="flex flex-col gap-2.5" aria-labelledby="compare-coverage">
            <h2 id="compare-coverage" className="text-sm font-semibold text-fg">
              Coverage
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Missions covered" d={c.charter.covered} />
              <Stat label="Missions blocked" d={c.charter.blocked} invert />
              {c.journeys.total.a + c.journeys.total.b > 0 ? <Stat label="Journeys passed" d={c.journeys.passed} /> : <Stat label="Steps" d={c.steps} />}
              <Stat label="Screens reached" d={c.screens} />
            </div>
            {c.journeys.changes.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-panel" aria-label="Journeys that changed">
                {c.journeys.changes.map((j) => (
                  <li key={j.name} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-fg">{j.name}</span>
                    <span className="text-xs text-muted">{j.a ?? "not run"}</span>
                    <ArrowRight aria-label="to" className="size-3 text-muted" />
                    <span className={cn("text-xs font-medium", j.b === "passed" ? "text-success" : j.b === "failed" ? "text-danger" : "text-fg-2")}>{j.b ?? "not run"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
