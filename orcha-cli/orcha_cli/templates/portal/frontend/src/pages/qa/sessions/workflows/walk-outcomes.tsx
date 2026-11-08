import { Link } from "../../map/kit";
import { ArrowUpRight, Check, CircleSlash, Lock, ScrollText, ShieldAlert, X } from "../../map/kit/icons";
import { severityTag } from "../../map/kit";
import { fmtDate, fmtDuration } from "../../map/kit";
import { qaHref } from "../../parts";
import { runHref } from "../links";
import type { Severity } from "../explorations";
import {
  BLOCKED_LABEL,
  failedWalkWhy,
  personaName,
  railSteps,
  scenarioPredates,
  scenarioSince,
  stoppedWalk,
  walkFindingsOf,
  type DraftingFlow,
  type FlowWalk,
  type Persona,
  type WalkFinding,
  type WalkScenario,
} from "../workflows/workflows";
import { cn } from "../../map/kit";
import { FrameThumb } from "./bits";
import styles from "./workflows.module.css";

const scenarioHref = (platform: string | null, id: string) => qaHref({ view: "scenarios", platform: platform === "ios" ? null : platform, scenario: id });

const OUTCOME = {
  passed: { word: "Passed", Icon: Check, ring: "border-success/35", stamp: "bg-success text-white dark:text-bg", glow: "var(--color-success)" },
  failed: { word: "Failed", Icon: X, ring: "border-danger/35", stamp: "bg-danger text-white dark:text-bg", glow: "var(--color-danger)" },
  unreachable: { word: "Unreachable", Icon: Lock, ring: "border-warning/40", stamp: "bg-warning text-white dark:text-bg", glow: "var(--color-warning)" },
  abandoned: { word: "Stopped", Icon: CircleSlash, ring: "border-border", stamp: "bg-muted text-white dark:text-bg", glow: "var(--color-muted)" },
} as const;

/** The frames of a walk in order, as a strip of small prints (the trace, at a glance). */
function FilmStrip({ walk, kind }: { walk: FlowWalk; kind: string | null }) {
  const framed = walk.steps.filter((s) => s.frame);
  if (framed.length === 0) return null;
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-0.5" aria-label="The walk's frames">
      {framed.map((s) => (
        <span key={s.index} className="flex flex-col items-center gap-0.5">
          <FrameThumb frame={s.frame} kind={kind} label={`Step ${s.index}: ${s.text}`} size="xs" />
          <span aria-hidden className={cn("size-1 rounded-full", s.reached ? "bg-success" : "bg-danger")} />
        </span>
      ))}
    </div>
  );
}

/** What a scenario row is, in words, beside its link. */
const SCENARIO_STATE: Record<string, string> = { draft: "Draft to review", validated: "Accepted", paused: "Paused", retired: "Retired" };

/** Where a walk's scenario came from, in words: the person's own one it matched, or a new draft. */
export function scenarioLinkWords(walk: Pick<FlowWalk, "status" | "started_at">, scenario: WalkScenario | undefined): { label: string; state: string | null; matched: boolean } {
  const matched = scenarioPredates(scenario, walk);
  const word = scenario ? (SCENARIO_STATE[scenario.status] ?? scenario.status) : null;
  if (matched && scenario && word) {
    return {
      label: walk.status === "failed" ? "Your scenario that will catch it" : "Matches your scenario",
      state: scenarioSince(scenario, word, (iso) => fmtDate(iso, { time: false })),
      matched,
    };
  }
  return { label: walk.status === "failed" ? "Scenario that will catch it" : "Draft built from this walk", state: word, matched };
}

function ScenarioLink({ walk, scenario, id, platform, i }: { walk: FlowWalk; scenario: WalkScenario | undefined; id: string; platform: string | null; i: number }) {
  const name = scenario?.name ?? "A scenario";
  const { label, state, matched } = scenarioLinkWords(walk, scenario);
  const inner = (
    <>
      <ScrollText aria-hidden className="size-4 shrink-0 text-primary dark:text-chart-1" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <span className="truncate text-sm font-medium text-fg">{name}</span>
      </span>
      {state ? <span className="shrink-0 text-2xs text-muted">{state}</span> : null}
      {id ? <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted" /> : null}
    </>
  );
  const cls = cn("flex min-w-0 items-center gap-2 rounded-lg border border-border bg-panel-2/60 px-2.5 py-2", styles.produced);
  return id ? (
    <Link
      href={scenarioHref(platform, id)}
      className={cn(cls, "outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring")}
      style={{ ["--i" as string]: i }}
      data-walk-scenario={id}
      data-walk-scenario-matched={matched ? "" : undefined}
    >
      {inner}
    </Link>
  ) : (
    <div className={cls} style={{ ["--i" as string]: i }} data-walk-scenario={id} data-walk-scenario-matched={matched ? "" : undefined}>
      {inner}
    </div>
  );
}

/**
 * One finished walk, landing with its outcome: passed (the draft built from its trace,
 * linked), failed (the finding and the scenario that will catch it) or unreachable (the reason,
 * and that nothing was drafted blind). The stamp lands a beat after the card; reduced motion
 * shows it in place.
 */
export function WalkOutcome({
  walk,
  flow,
  personas,
  scenarios,
  findings,
  platform,
  kind,
  live = false,
  i = 0,
}: {
  walk: FlowWalk;
  flow: DraftingFlow | null;
  personas: readonly Persona[];
  scenarios: Record<string, WalkScenario>;
  findings: Record<string, WalkFinding>;
  platform: string | null;
  kind: string | null;
  /** The exploration still runs: a capture without its finding yet is still being written up. */
  live?: boolean;
  i?: number;
}) {
  const status = walk.status === "walking" ? "abandoned" : walk.status;
  // A walk that stopped says why in words: "Cut off by time" when the time ran out.
  const stopped = status === "abandoned" ? stoppedWalk(walk.reason) : null;
  const o = stopped ? { ...OUTCOME.abandoned, word: stopped.word } : OUTCOME[status];
  const name = flow?.name ?? walk.flow_key;
  const rail = railSteps(flow, walk);
  const reached = walk.steps.filter((s) => s.reached).length;
  const checks = walk.steps.reduce((n, s) => n + (s.reached ? s.checked.length : 0), 0);
  const persona = personaName(walk.persona ?? flow?.persona, personas);
  const took = walk.finished_at ? (Date.parse(walk.finished_at) - Date.parse(walk.started_at)) / 1000 : null;
  const missed = walk.steps.find((s) => !s.reached) ?? null;
  const { found: walkFindings, pending } = walkFindingsOf(walk, findings);
  const why = failedWalkWhy(walk, walkFindings.length, pending.length);
  const frameKind = walk.target_kind ?? flow?.target_kind ?? kind;

  return (
    <article
      id={`walk-${walk.id}`}
      className={cn("relative flex scroll-mt-20 flex-col gap-3 overflow-hidden rounded-xl border bg-panel p-4", o.ring, styles.landing)}
      style={{ ["--i" as string]: i }}
      aria-labelledby={`walk-${walk.id}-title`}
      data-walk-outcome={status}
      data-walk-flow={walk.flow_key}
    >
      {/* A soft corner of the outcome's colour. A gradient, not a blurred circle: WebKit (the Mac
          app) clips a blur inside this rounded, clipped, animated card to a hard-edged box and
          repaints it on every live update, so it flickered. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(180px circle at 100% 0%, color-mix(in srgb, ${o.glow} 12%, transparent), transparent 70%)` }}
      />
      <header className="relative flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full shadow-[var(--shadow-md)]", o.stamp, styles.stamp)} style={{ ["--i" as string]: i }} aria-hidden>
          <o.Icon className="size-4.5" strokeWidth={2.75} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4 id={`walk-${walk.id}-title`} className="text-sm font-semibold leading-5 text-fg">
            <span className="sr-only">{o.word}: </span>
            {name}
          </h4>
          <p className="text-xs text-muted">
            {o.word}
            {why.problems ? <span className="font-medium text-danger">{` · ${why.problems}`}</span> : null}
            {persona ? ` · as ${persona}` : ""}
            {rail.length ? ` · ${reached} of ${rail.length} steps reached` : ""}
            {checks ? ` · ${checks} check${checks === 1 ? "" : "s"} held` : ""}
            {took != null && took > 0 ? ` · ${fmtDuration(took)}` : ""}
          </p>
        </div>
      </header>

      {status === "failed" ? (
        <div className="flex flex-col gap-2">
          {missed ? (
            <p className="text-sm leading-5 text-fg">
              <span className="font-medium">
                Failed at step {missed.index}
                {rail.length ? ` of ${rail.length}` : ""}:
              </span>{" "}
              {missed.text}
            </p>
          ) : why.step ? (
            <p className="text-sm leading-5 text-fg">
              <span className="font-medium">
                Problem found at step {why.step.index}
                {rail.length ? ` of ${rail.length}` : ""}:
              </span>{" "}
              {why.step.text}
            </p>
          ) : null}
          {walk.reason || missed?.result ? <p className="text-sm leading-5 text-fg-2">{walk.reason ?? missed?.result}</p> : null}
          {walkFindings.map((f) => (
            <Link
              key={f.id}
              href={runHref(f.run_id)}
              className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-danger/25 bg-danger/[0.05] px-2.5 py-2 outline-none hover:border-danger/40 focus-visible:ring-2 focus-visible:ring-ring", styles.produced)}
              style={{ ["--i" as string]: i }}
              data-walk-finding={f.id}
            >
              <ShieldAlert aria-hidden className="size-4 shrink-0 text-danger" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted">Finding</span>
                <span className="truncate text-sm font-medium text-fg">{f.title}</span>
              </span>
              <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium capitalize", severityTag[f.severity as Severity] ?? "bg-panel-2 text-fg-2")}>{f.severity}</span>
              <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted" />
            </Link>
          ))}
          {live && walkFindings.length === 0 && pending.length > 0 ? (
            <p className="text-xs text-muted" data-walk-finding-pending>
              The finding from evidence #{pending.join(", #")} is still being written up.
            </p>
          ) : null}
          {walk.scenario_id ? (
            <ScenarioLink walk={walk} scenario={scenarios[walk.scenario_id]} id={walk.scenario_id} platform={platform} i={i} />
          ) : (
            <p className="text-xs text-muted">The scenario that will catch it is being drafted.</p>
          )}
        </div>
      ) : null}

      {status === "unreachable" ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm leading-5 text-fg">
            <span className="font-medium">{walk.blocked_kind ? BLOCKED_LABEL[walk.blocked_kind] : "Could not reach it"}</span>
            {walk.reason ? <span className="text-fg-2">: {walk.reason}</span> : null}
          </p>
          <p className="text-xs text-muted">Nothing drafted: a scenario is never written blind. Give Embodent what it needs and walk it again.</p>
        </div>
      ) : null}

      {stopped ? (
        <p className="text-sm leading-5 text-fg-2" data-walk-stopped>
          {stopped.why}
        </p>
      ) : null}

      <FilmStrip walk={walk} kind={frameKind} />

      {status === "passed" ? (
        walk.scenario_id ? (
          <ScenarioLink walk={walk} scenario={scenarios[walk.scenario_id]} id={walk.scenario_id} platform={platform} i={i} />
        ) : (
          <p className="text-xs text-muted">The draft from this walk is being written.</p>
        )
      ) : null}
    </article>
  );
}

export function WalkOutcomes({
  walks,
  flows,
  personas,
  scenarios,
  findings,
  platform,
  kind,
  live = false,
}: {
  walks: readonly FlowWalk[];
  flows: readonly DraftingFlow[];
  personas: readonly Persona[];
  scenarios: Record<string, WalkScenario>;
  findings: Record<string, WalkFinding>;
  platform: string | null;
  kind: string | null;
  live?: boolean;
}) {
  const byId = new Map(flows.map((f) => [f.id, f]));
  if (walks.length === 0) return null;
  return (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2" data-walk-outcomes={walks.length}>
      {walks.map((w, i) => (
        <WalkOutcome
          key={w.id}
          walk={w}
          flow={byId.get(w.flow_id) ?? null}
          personas={personas}
          scenarios={scenarios}
          findings={findings}
          platform={platform}
          kind={kind}
          live={live}
          i={i}
        />
      ))}
    </div>
  );
}
