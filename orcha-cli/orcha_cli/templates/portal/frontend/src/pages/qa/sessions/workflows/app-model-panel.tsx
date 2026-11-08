import { useState } from "react";
import {
  Check,
  ChevronDown,
  CircleDashed,
  Code2,
  FileText,
  FlaskConical,
  Footprints,
  History,
  Lock,
  Route,
  ScrollText,
  Smartphone,
  Sparkles,
  UserRound,
  X,
} from "../../map/kit/icons";
import { fmtRelative } from "../../map/kit";
import type { Platform } from "../../qaApi";
import {
  evidenceTally,
  personaName,
  rankModelWorkflows,
  SOURCE_LABEL,
  type AppModel,
  type AppModelPayload,
  type EvidenceKind,
  type ModelWorkflow,
} from "../workflows/workflows";
import { cn } from "../../map/kit";
import { useAppModel } from "./use-workflow-walks";
import styles from "./workflows.module.css";

const EVIDENCE: Record<EvidenceKind, { Icon: typeof Route; one: string; many: string }> = {
  screens: { Icon: Smartphone, one: "screen", many: "screens" },
  routes: { Icon: Route, one: "route", many: "routes" },
  tests: { Icon: FlaskConical, one: "test", many: "tests" },
  docs: { Icon: FileText, one: "doc", many: "docs" },
  code: { Icon: Code2, one: "place in the code", many: "places in the code" },
  scenarios: { Icon: ScrollText, one: "scenario", many: "scenarios" },
  runs: { Icon: Footprints, one: "walk", many: "walks" },
};

const WF_STATUS: Record<ModelWorkflow["status"], { word: string; Icon: typeof Check; cls: string }> = {
  unwalked: { word: "Not walked yet", Icon: CircleDashed, cls: "text-muted" },
  passed: { word: "Passed", Icon: Check, cls: "text-success" },
  failed: { word: "Failed", Icon: X, cls: "text-danger" },
  unreachable: { word: "Unreachable", Icon: Lock, cls: "text-warning" },
};

const CRIT: Record<ModelWorkflow["criticality"], string> = {
  critical: "bg-sev-major/12 text-sev-major",
  high: "bg-chart-3/12 text-chart-3 dark:text-warning",
  normal: "bg-panel-2 text-fg-2",
  low: "bg-panel-2 text-muted",
};

function WorkflowRow({ w, model, i }: { w: ModelWorkflow; model: AppModel; i: number }) {
  const s = WF_STATUS[w.status];
  const tally = evidenceTally(w.evidence);
  const persona = personaName(w.persona, model.personas);
  return (
    <li className={cn("flex min-w-0 items-start gap-2.5 px-3 py-2", styles.queueRow)} style={{ ["--i" as string]: i }} data-model-workflow={w.key} data-model-status={w.status}>
      <s.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", s.cls)} strokeWidth={2.25} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 text-sm font-medium text-fg">{w.name}</span>
          <span className={cn("rounded-full px-1.5 text-[11px] font-medium capitalize leading-[18px]", CRIT[w.criticality])}>{w.criticality}</span>
          <span className={cn("text-xs", s.cls)}>
            <span className="sr-only">Status: </span>
            {s.word}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
          {persona ? (
            <span className="inline-flex items-center gap-1">
              <UserRound aria-hidden className="size-3" />
              {persona}
            </span>
          ) : null}
          {w.steps.length ? <span>{w.steps.length} {w.steps.length === 1 ? "step" : "steps"}</span> : null}
          {tally.map(({ kind, count }) => {
            const e = EVIDENCE[kind];
            const words = `${count} ${count === 1 ? e.one : e.many}`;
            return (
              <span key={kind} className="inline-flex items-center gap-0.5 tabular" title={words}>
                <e.Icon aria-hidden className="size-3" />
                <span aria-hidden>{count}</span>
                <span className="sr-only">{words}</span>
              </span>
            );
          })}
          {tally.length === 0 ? <span>No evidence yet</span> : null}
          {w.last_walk?.reason && w.status === "unreachable" ? <span className="text-warning">{w.last_walk.reason}</span> : null}
        </div>
      </div>
    </li>
  );
}

/** How the workflows stand, as one bar: passed, failed, unreachable, not walked. */
function StatusBar({ workflows }: { workflows: readonly ModelWorkflow[] }) {
  const total = workflows.length || 1;
  const n = (s: ModelWorkflow["status"]) => workflows.filter((w) => w.status === s).length;
  const parts = [
    { key: "passed", n: n("passed"), cls: "bg-success", word: "passed" },
    { key: "failed", n: n("failed"), cls: "bg-danger", word: "failed" },
    { key: "unreachable", n: n("unreachable"), cls: "bg-warning", word: "unreachable" },
    { key: "unwalked", n: n("unwalked"), cls: "bg-border-strong", word: "not walked yet" },
  ].filter((p) => p.n > 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-panel-2" aria-hidden>
        {parts.map((p, i) => (
          <span key={p.key} className={cn("h-full rounded-full", p.cls, styles.meter)} style={{ width: `${(p.n / total) * 100}%`, ["--i" as string]: i }} />
        ))}
      </div>
      <p className="text-xs text-fg-2">{parts.map((p) => `${p.n} ${p.word}`).join(" · ")}</p>
    </div>
  );
}

/**
 * The App model: what Orcha understands the app to be. Its purpose, the people who use
 * it, the jobs they come to do, and the workflows ranked by what matters (criticality, then what
 * needs a walk most), each with its status and how much evidence backs it. The version history
 * shows where each version came from (the study, the drafter's flows, walks, a person); picking
 * one shows it. New versions arrive live. Read only: editing it is v2.
 */
export function AppModelPanel({
  cid,
  platform,
  appName,
  initial = null,
  compact = false,
  className,
}: {
  cid: string;
  platform: Platform;
  appName: string;
  initial?: AppModelPayload | null;
  /** On a busy page: the first workflows, with a way to see them all. */
  compact?: boolean;
  className?: string;
}) {
  const state = useAppModel(cid, platform, false, initial);
  return <AppModelView state={state} appName={appName} compact={compact} className={className} />;
}

/** The App model panel over a `useAppModel` state (a page that already reads the model shares it). */
export function AppModelView({
  state,
  appName,
  compact = false,
  className,
}: {
  state: ReturnType<typeof useAppModel>;
  appName: string;
  compact?: boolean;
  className?: string;
}) {
  const { data, loading, picked, pick } = state;
  const [all, setAll] = useState(!compact);
  const [history, setHistory] = useState(false);
  const model = data?.model ?? null;

  if (loading && !data) {
    return <div className={cn("v-skeleton h-48 rounded-xl", className)} aria-label="Loading the App model" />;
  }

  const ranked = model ? rankModelWorkflows(model.workflows) : [];
  const shown = all ? ranked : ranked.slice(0, 5);
  const newest = data?.versions[0]?.version ?? null;

  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-panel p-4", className)} aria-labelledby="app-model-title" data-app-model={data?.version ?? "none"}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:text-chart-1" aria-hidden>
          <Sparkles className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id="app-model-title" className="text-sm font-semibold text-fg">
            What Embodent understands {appName} to be
          </h3>
          {data?.version != null ? (
            <p className="text-xs text-muted" data-app-model-version={data.version}>
              <span key={data.version} className="v-pop inline-block font-medium text-fg-2">
                Version {data.version}
              </span>
              {data.version === newest ? " (newest)" : ""} · {data.source ? SOURCE_LABEL[data.source] : ""} ·{" "}
              <span suppressHydrationWarning>{fmtRelative(data.created_at)}</span>
            </p>
          ) : (
            <p className="text-xs text-muted">The App model, shared by the explorer and the drafter.</p>
          )}
        </div>
        {data && data.versions.length > 0 ? (
          <button
            type="button"
            onClick={() => setHistory((h) => !h)}
            aria-expanded={history}
            aria-controls="app-model-history"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-fg-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            data-app-model-history-toggle
          >
            <History aria-hidden className="size-3.5" />
            {data.versions.length} version{data.versions.length === 1 ? "" : "s"}
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", history && "rotate-180")} />
          </button>
        ) : null}
      </header>

      {history && data ? (
        <ol id="app-model-history" className={cn("flex flex-col gap-1 rounded-lg border border-border bg-panel-2/50 p-1.5", styles.reveal)} aria-label="Version history">
          {data.versions.map((v) => {
            const current = (picked ?? newest) === v.version;
            return (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => pick(v.version === newest ? null : v.version)}
                  aria-pressed={current}
                  className={cn(
                    "flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                    current && "bg-panel shadow-[var(--shadow-sm)]",
                  )}
                  data-app-model-pick={v.version}
                >
                  <span className="w-7 shrink-0 font-mono font-semibold tabular text-fg">v{v.version}</span>
                  <span className="shrink-0 text-fg-2">{SOURCE_LABEL[v.source] ?? v.source}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{v.summary ?? ""}</span>
                  <span className="shrink-0 text-muted" suppressHydrationWarning>
                    {fmtRelative(v.created_at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {!model ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-muted" data-app-model-empty>
          No App model yet. The study builds one from the code, tests, docs and the map the first time Embodent walks this app&apos;s workflows.
        </p>
      ) : (
        <>
          {model.purpose ? <p className="text-[15px] leading-6 text-fg">{model.purpose}</p> : null}

          {model.personas.length || model.core_jobs.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {model.personas.length ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="text-2xs font-medium uppercase tracking-wide text-muted">Who uses it</h4>
                  <ul className="flex flex-col gap-1">
                    {model.personas.map((p) => (
                      <li key={p.key} className="flex min-w-0 items-start gap-1.5 text-sm">
                        <UserRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
                        <span className="min-w-0">
                          <span className="font-medium text-fg">{p.name}</span>
                          {p.goal ? <span className="text-fg-2">: {p.goal}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {model.core_jobs.length ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="text-2xs font-medium uppercase tracking-wide text-muted">What they come to do</h4>
                  <ul className="flex flex-wrap gap-1">
                    {model.core_jobs.map((j) => (
                      <li key={j.key} className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-2" title={j.why ?? undefined}>
                        {j.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {ranked.length ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h4 className="text-2xs font-medium uppercase tracking-wide text-muted">Workflows</h4>
                <span className="text-2xs tabular text-muted">{ranked.length}</span>
              </div>
              <StatusBar workflows={ranked} />
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Workflows, most important first">
                {shown.map((w, i) => (
                  <WorkflowRow key={w.key} w={w} model={model} i={i} />
                ))}
              </ul>
              {ranked.length > shown.length || (compact && all) ? (
                <button type="button" onClick={() => setAll((a) => !a)} className="self-start text-xs font-medium text-fg-2 underline-offset-2 hover:text-fg hover:underline">
                  {all ? "Show fewer" : `Show all ${ranked.length} workflows`}
                </button>
              ) : null}
            </div>
          ) : null}

          {model.built_from.tests || model.built_from.docs || model.built_from.scenarios || model.built_from.map_build_id ? (
            <p className="text-xs text-muted">
              Built from{" "}
              {[
                model.built_from.map_build_id ? "the app map" : null,
                model.built_from.tests ? `${model.built_from.tests} test${model.built_from.tests === 1 ? "" : "s"}` : null,
                model.built_from.docs ? `${model.built_from.docs} doc${model.built_from.docs === 1 ? "" : "s"}` : null,
                model.built_from.scenarios ? `${model.built_from.scenarios} scenario${model.built_from.scenarios === 1 ? "" : "s"}` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              , and refined by every walk.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
