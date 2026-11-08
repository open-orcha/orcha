import { Route, RouteOff, Timer } from "../../map/kit/icons";
import type { Platform, QaFlow, SessionDetail } from "../../qaApi";
import type { TargetKind } from "../explorations";
import { cn } from "../../map/kit";
import {
  currentWalk,
  finishedWalks,
  FLOW_STATUS_LABEL,
  queueOrder,
  stoppedWalk,
  unwalkedCopy,
  unwalkedQueue,
  type UnwalkedQueue,
} from "../workflows/workflows";
import { AppModelView } from "./app-model-panel";
import { FlowQueue } from "./flow-queue";
import { useAppModel, useWorkflowWalks } from "./use-workflow-walks";
import { WalkInProgress } from "./walk-live";
import { WalkOutcomes } from "./walk-outcomes";
import { WalkScene, walkExample } from "./walk-scene";
import styles from "./workflows.module.css";

/**
 * A workflow-driven exploration on its own page, beside the classic faces: the walk in
 * progress, the ranked flow queue, each finished walk landing with its outcome, and the App
 * model they all feed. Live from the change feed on `drafting_flows`, `flow_walks` and
 * `app_models` while the page is open. Before the first flows are queued it teaches what is
 * about to happen; once the exploration ends it is the record of what was walked, and says so
 * plainly when the explorer walked none of the queue.
 */
export function WorkflowSection({
  cid,
  platform,
  appName,
  detail,
  flows: rows,
  live,
  kind,
  exampleFeature = null,
}: {
  cid: string;
  platform: Platform;
  appName: string;
  /** The session as the page reads it live, with the platform's flow queue. */
  detail: SessionDetail;
  flows: readonly QaFlow[] | null;
  /** The exploration still runs. */
  live: boolean;
  kind: TargetKind | null;
  /** A feature of this project the teaching scene's example can be about, when its App model has no flow yet. */
  exampleFeature?: string | null;
}) {
  const data = useWorkflowWalks(detail, rows);
  const model = useAppModel(cid, platform, live);
  const personas = model.data?.model?.personas ?? [];
  const flows = data.flows;
  // Only a running exploration walks: once it ended, a walk still marked walking was cut off and
  // lands with the others, never "Walking" forever.
  const walking = live ? currentWalk(data.walks) : null;
  const done = finishedWalks(data.walks, live);
  const flowById = new Map(flows.map((f) => [f.id, f]));
  const next = queueOrder(flows).find((f) => f.status === "queued") ?? null;
  // Ended with flows queued and none walked: never presented as a pairing that ran.
  const unwalked = unwalkedQueue(flows, data.walks, live, data.explorer_joined);
  const lead = walking || (live && next) || unwalked;

  return (
    <section id="sec-walks" className="flex scroll-mt-20 flex-col gap-4" aria-labelledby="workflows-title" data-workflow-section={live ? "live" : "done"}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:text-chart-1" aria-hidden>
          <Route className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="workflows-title" className="flex flex-wrap items-center gap-2 text-base font-semibold text-fg">
            {unwalked ? "The app's workflows" : "The app's workflows, walked"}
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[11px] font-medium text-primary dark:text-chart-1" data-workflow-pairing>
              Workflow pairing
            </span>
            {unwalked ? (
              <span className="rounded-full bg-warning/12 px-1.5 py-px text-[11px] font-medium text-warning" data-workflow-unwalked>
                Not walked
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-fg-2">
            {unwalked
              ? "This exploration was paired to walk the drafter's flows end to end, each walk becoming a scenario."
              : "The drafter's flows are the explorer's work: each one is walked end to end, and each walk becomes a scenario."}
          </p>
        </div>
      </header>

      {flows.length === 0 ? (
        live ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4" data-workflow-empty="teaching">
            <p className="text-sm text-fg-2">
              The drafter is reading the code and ranking the app&apos;s workflows. They land here in the order the explorer walks them.
            </p>
            <WalkScene example={walkExample(model.data?.model, exampleFeature)} />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted" data-workflow-empty="ended">
            No flows were queued in this exploration, so nothing was walked. The report below is the explorer&apos;s own.
          </p>
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] xl:grid-rows-[auto_1fr]">
          {/* One column: the walk, the queue, then what was walked. Wide: the queue beside both. */}
          {walking ? (
            <div className="min-w-0 xl:col-start-1 xl:row-start-1">
              <WalkInProgress walk={walking} flow={flowById.get(walking.flow_id) ?? null} personas={personas} kind={kind} />
            </div>
          ) : live && next ? (
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/[0.03] px-4 py-3 xl:col-start-1 xl:row-start-1" data-walk-between>
              <Timer aria-hidden className="size-4 shrink-0 text-primary dark:text-chart-1" />
              <p className="text-sm text-fg-2">
                Up next: <span className="font-medium text-fg">{next.name}</span>. The explorer picks it up as soon as it is free.
              </p>
            </div>
          ) : unwalked ? (
            <QueueNotWalked unwalked={unwalked} className="xl:col-start-1 xl:row-start-1" />
          ) : null}
          <FlowQueue flows={flows} walks={data.walks} personas={personas} live={live} className="xl:sticky xl:top-4 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start" />
          {done.length ? (
            <div className={lead ? "flex min-w-0 flex-col gap-2.5 xl:col-start-1 xl:row-start-2" : "flex min-w-0 flex-col gap-2.5 xl:col-start-1 xl:row-start-1 xl:row-span-2"}>
              <h3 className="text-sm font-semibold text-fg">
                Walked <span className="font-normal tabular text-muted">{done.length}</span>
              </h3>
              <p className="sr-only" aria-live="polite">
                {done[0]
                  ? `${flowById.get(done[0].flow_id)?.name ?? done[0].flow_key}: ${done[0].status === "abandoned" ? stoppedWalk(done[0].reason).word : FLOW_STATUS_LABEL[done[0].status]}.`
                  : ""}
              </p>
              <WalkOutcomes
                walks={done}
                flows={flows}
                personas={personas}
                scenarios={data.scenarios}
                findings={data.findings}
                platform={platform}
                kind={kind}
                live={live}
              />
            </div>
          ) : null}
        </div>
      )}

      <AppModelView state={model} appName={appName} compact />
    </section>
  );
}

/**
 * An ended exploration that walked none of its queue, said plainly where the walk would
 * have been: why (when the page can tell: the explorer never joined the session), and that its
 * findings and drafts come from exploring, not from walks. It lands like a walk outcome.
 */
function QueueNotWalked({ unwalked, className }: { unwalked: UnwalkedQueue; className?: string }) {
  const copy = unwalkedCopy(unwalked);
  return (
    <div
      role="note"
      aria-labelledby="queue-not-walked-title"
      className={cn("flex min-w-0 gap-3 rounded-xl border border-warning/40 bg-warning/[0.06] px-4 py-3.5", styles.landing, className)}
      data-queue-not-walked={unwalked.joined === false ? "never-joined" : "not-walked"}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning" aria-hidden>
        <RouteOff className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p id="queue-not-walked-title" className="text-sm font-semibold text-fg">
          {copy.title}
        </p>
        <p className="text-sm text-fg-2">{copy.body}</p>
        <p className="text-xs text-muted">{copy.after}</p>
      </div>
    </div>
  );
}
