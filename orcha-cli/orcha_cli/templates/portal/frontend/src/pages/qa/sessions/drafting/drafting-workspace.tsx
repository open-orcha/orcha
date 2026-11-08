import { type ReactNode } from "react";
import { Compass, Play } from "../../map/kit/icons";
import { Button, Link, PLATFORM_LABELS, PlatformIcon, buttonVariants } from "../../map/kit";
import { WorkPhaseBar } from "../work/phase-bar";
import { WorkTitle } from "../work/work-title";
import { CountRing, WorkPage, WorkSummary } from "../work/work-done";
import { WorkCalm, WorkFact, WorkFacts, WorkHeading, WorkLive, WorkLog } from "../work/work-live";
import {
  calmLine,
  draftingJobName,
  draftingStage,
  DRAFTING_STAGE_LABEL,
  newestFile,
  phasesFor,
  requestWorkStatus,
  type WorkPhase,
  type WorkStatus,
} from "../work/words";
import { useNow } from "../detail/phase-timeline";
import { ExplorationGoal } from "../detail/header";
import type { QaAuthority } from "../../authority";
import { qaHref } from "../../parts";
import type { SessionDetail } from "../../qaApi";
import { explorationPassLine, passLeadsStatus, passWaitsForDevice, type DraftChoice } from "./lib/draft-sources";
import { draftingStep, isOpenPhase, progressLine } from "./lib/drafting-route";
import { ConversationFeed } from "./conversation-feed";
import { DraftingSplit, splitFrame, useWideDrafting } from "./drafting-split";
import { DraftingStage } from "./drafting-stage";
import { DraftingError, DraftReview, ExplorationPassCard } from "./drafting-parts";
import { Gated } from "./gated";
import { RunPlacement, runPlacement } from "./run-placement";
import { StatusLine } from "./status-line";
import { useDraftingSession, type DraftingProject, type DraftingSession } from "./use-drafting-session";

const CHOICE_LABEL: Record<DraftChoice, string> = {
  code: "Code",
  past: "Code + past explorations",
  new: "Code + a new exploration",
};

/** The drafting job's phases, in the bar's vocabulary. */
const STEP_PHASE: readonly WorkPhase[] = ["read", "draft", "review", "run"];

/** The status bar's one line: the drafting from code, or the new exploration while it leads. */
export function statusBarLine(session: Pick<DraftingSession, "gen" | "pass" | "codePhase" | "drafts" | "started" | "sources" | "drafted">, projectName: string, now: number): string {
  const { gen, pass, codePhase, drafts } = session;
  if (passLeadsStatus(codePhase, pass.stage) && pass.explore) {
    const drafted = pass.followUpId ? drafts.filter((x) => x.generation_request_id === pass.followUpId).length : 0;
    return explorationPassLine({ e: pass.explore, followUp: pass.followUp, projectName, screens: pass.screens, drafted, now });
  }
  if (codePhase === "idle") return session.started ? "Starting…" : "Choose what to read, then start drafting";
  return progressLine({
    phase: codePhase,
    sources: session.sources,
    draftCount: drafts.length,
    drafted: session.drafted,
    error: gen.progress?.error ?? null,
  });
}

/** The drafts by area, biggest first, from the drafts on the page (the drafter's own tally left
 * out the ones the exploration wrote: Slate's 12 drafts showed bars summing to 9). Past `most`
 * rows the rest fold into "Other", so the bars always add up to the drafts. The drafter's tally
 * stands in until the first draft arrives. */
export function draftAreas(drafts: readonly { category?: string | null }[], tally: Record<string, number> | null | undefined, most = 5): [string, number][] {
  const counts = new Map<string, number>();
  if (drafts.length) for (const d of drafts) counts.set(d.category?.trim() || "Other", (counts.get(d.category?.trim() || "Other") ?? 0) + 1);
  else for (const [c, n] of Object.entries(tally ?? {})) if (n > 0) counts.set(c, n);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] === "Other" ? 1 : b[0] === "Other" ? -1 : a[0].localeCompare(b[0])));
  if (sorted.length <= most) return sorted;
  const kept = sorted.filter(([c]) => c !== "Other").slice(0, most - 1);
  const rest = sorted.filter((e) => !kept.includes(e)).reduce((n, [, k]) => n + k, 0);
  return [...kept, ["Other", rest]];
}

/**
 * A drafting session on its page, in the "Orcha at work" frame every job shares: the title row
 * (the job's name, status, elapsed time; Stop or Run again, Open the task, Open the exploration)
 * with the facts under it, the phase bar (Read, Draft, Review, Run; Explore too with an explorer
 * on its task), and the live view: what Orcha reads on the left (the stage, the calm line with the
 * file it reads now, the explorer's device, the conversation, the activity log), the drafts on
 * the right, reviewed inline. Once it is done the summary (accepted of drafted, by area, the
 * counters) sits on top. A footer keeps the way back and Run what you accepted.
 *
 * Everything the page shows is derived from the session and its board (`useDraftingSession`), so
 * leaving and coming back resumes where the agent is.
 */
export function DraftingWorkspace({
  cid,
  detail,
  agent,
  back,
  primary,
  onRunCheck,
  auth,
  nonce,
  onReload,
}: {
  cid: string;
  detail: SessionDetail;
  agent: string | null;
  /** The way back, in the footer. */
  back: ReactNode;
  /** Stop while it runs, Run again once it ended. */
  primary: ReactNode;
  onRunCheck: (acceptedIds: readonly string[]) => void;
  auth: QaAuthority;
  nonce: number;
  /** Read the session again (its drafts, while a revision is out). */
  onReload: () => void;
}) {
  const s = detail.session;
  const project: DraftingProject = { name: "the app" };
  const session = useDraftingSession({ cid, detail, auth, agent, nonce, onReload });
  const { gen, phase, drafts, acceptedIds } = session;
  const now = useNow(true);

  const open = isOpenPhase(phase);
  const barLine = statusBarLine(session, project.name, now);
  const categories = draftAreas(session.drafts, gen.progress?.summary?.categories);
  // Wide screens with an explorer on the task: review side by side with its device.
  const wide = useWideDrafting();
  const split = wide && session.started && Boolean(session.pass.requestId);

  // The job: its name from what it is for, its status and phase.
  const name = draftingJobName(null, null);
  const activity = gen.progress?.progress ?? null;
  const ownDrafts = drafts.length - session.tags.size;
  const stage = draftingStage({ status: gen.status, drafted: ownDrafts });
  const passStage = session.pass.stage;
  // One agent explores, then drafts: while it explores, the exploration is what is going on.
  const exploringFirst = passStage === "exploring" && ownDrafts === 0;
  const line = exploringFirst ? "Exploring the app first. The drafts follow." : barLine;
  const passLeads = (exploringFirst || passLeadsStatus(session.codePhase, passStage)) && Boolean(session.pass.explore);
  const status: WorkStatus = !session.started
    ? "idle"
    : passLeads
      ? passStage === "queued"
        ? "queued"
        : passStage === "failed" || passStage === "draft-failed"
          ? "failed"
          : passStage === "cancelled"
            ? "stopped"
            : passStage === "done" || passStage === "skipped"
              ? "done"
              : "running"
      : phase === "starting"
        ? "queued"
        : requestWorkStatus(gen.status);
  const doing = passLeads ? (passStage === "exploring" ? "Exploring" : "Drafting") : DRAFTING_STAGE_LABEL[stage];
  // The exploration waits for a device another run holds: the same words as its own page.
  const waitingFor = status === "queued" && passLeads && session.pass.explore && passWaitsForDevice(session.pass.explore) ? "Waiting for a device" : null;
  const step = draftingStep({ phase, draftCount: drafts.length, accepted: acceptedIds.length });
  const phases = phasesFor(session.pass.requestId ? "drafting-exploration" : "drafting");
  const current: WorkPhase | null =
    !session.started || status === "queued"
      ? null
      : passLeads && (passStage === "exploring" || passStage === "queued")
        ? "explore"
        : STEP_PHASE[step];
  const done = session.started && !open && (session.codePhase === "completed" || session.codePhase === "cancelled") && !passLeads;
  const viewedRun = session.pass.requestId;

  const title = (
    <WorkTitle
      name={name}
      status={status}
      doing={doing}
      waiting={waitingFor}
      startedAt={s.started_at}
      endedAt={done ? s.ended_at : null}
      primary={primary}
      // What it was told: the task the agent works.
      brief={
        s.task_id ? (
          <Link href={`/tasks?task=${encodeURIComponent(s.task_id)}`} className={buttonVariants()} title={s.task_title ?? "The task the agent works"} data-drafting-task>
            Open the task
          </Link>
        ) : null
      }
      openRun={
        viewedRun ? (
          <Link
            href={qaHref({ view: "sessions", session: viewedRun })}
            className={buttonVariants()}
            title="Open the exploration"
            data-drafting-exploration={viewedRun}
          >
            <Compass /> <span className="max-sm:sr-only">Open the exploration</span>
          </Link>
        ) : null
      }
      facts={<RunFacts session={session} detail={detail} agent={agent} />}
    >
      <ExplorationGoal goal={s.goal?.trim() || null} />
      <p
        className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
        data-generation-status={gen.status ?? undefined}
        aria-live="polite"
      >
        <span className={phase === "failed" ? "text-danger" : "text-fg-2"} data-generation-progress>
          {line}
        </span>
        {categories.length > 0 && !done ? (
          <span className="text-xs text-muted" data-generation-categories>
            {categories.map(([c, n]) => `${c} ${n}`).join(" · ")}
          </span>
        ) : null}
      </p>
    </WorkTitle>
  );
  const phaseBar = (
    <WorkPhaseBar
      phases={phases}
      current={current}
      // The stage under it carries the counters; the bar stays quiet.
      caption={null}
      label="Drafting phases"
    />
  );
  const run = (
    <Button variant={acceptedIds.length > 0 ? "primary" : "default"} disabled={!auth.can || acceptedIds.length === 0} onClick={() => onRunCheck(acceptedIds)} data-run-accepted>
      <Play /> Run what you accepted
    </Button>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-drafting-page={phase}
      data-generate-scenarios
      data-generation-request={gen.requestId ?? undefined}
      data-explore-request={gen.exploreRequestId ?? undefined}
    >
      {split ? (
        // An explorer on a wide screen: its device fills the left column, sized to the window, and
        // the drafts scroll on their own on the right.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-drafting-scroll>
          <div className="mx-auto flex w-full max-w-[1480px] shrink-0 flex-col gap-5 px-5 pt-5" data-drafting-bar>
            {title}
            {phaseBar}
          </div>
          <DraftingSplit
            frame={splitFrame(session.pass.explore?.target_kind, { deviceName: session.pass.explore?.run?.deviceName })}
            className="mx-auto w-full max-w-[1480px] px-5 py-5"
            left={
              <>
                <ExplorationPassCard session={session} projectName={project.name} fit className="min-h-0 flex-1" />
                <ConversationFeed board={session.board} screens={session.pass.requestId ? session.pass.screens : undefined} className="mt-3" maxHeight={180} />
                <DraftingError error={gen.error} />
              </>
            }
          >
            {done ? <DraftingSummary session={session} name={name} /> : null}
            <DraftingStage
              activity={activity}
              status={gen.status}
              drafted={ownDrafts}
              frames={session.frames}
              exploring={exploringFirst}
              collapsible
              autoCollapse={drafts.length > 0}
              className="shrink-0"
            />
            <WorkLog
              lines={(activity?.recent ?? []).filter((l): l is string => typeof l === "string" && l.trim() !== "")}
              live={open}
              open={false}
              className="shrink-0"
            />
            <CodeOutcome session={session} />
            <DraftsSection session={session} />
          </DraftingSplit>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" data-drafting-scroll>
          <WorkPage>
            <div className="flex flex-col gap-5" data-drafting-bar>
              {title}
              {phaseBar}
            </div>
            {done ? <DraftingSummary session={session} name={name} /> : null}
            <WorkLive
              sees={
                <div className="flex min-w-0 flex-col gap-4" data-drafting-left>
                  <ReadingColumn session={session} project={project} stage={stage} />
                  <DraftingError error={gen.error} />
                </div>
              }
              produces={<DraftsSection session={session} />}
            />
          </WorkPage>
        </div>
      )}

      {/* Footer: leave, or run what was accepted. */}
      <div
        className="flex shrink-0 items-center gap-2 border-t border-border bg-bg px-5 py-2.5 max-[720px]:px-4"
        data-drafting-footer
      >
        {back}
        <span className="ml-auto">
          <Gated auth={auth.can && acceptedIds.length === 0 ? { ...auth, can: false, reason: "Accept at least one scenario to run it" } : auth}>{run}</Gated>
        </span>
      </div>
    </div>
  );
}

/** Left column: the stage, the calm line and the file read now, the explorer, the conversation,
 * the activity log, why it ended early. */
function ReadingColumn({
  session,
  project,
  stage,
}: {
  session: DraftingSession;
  project: DraftingProject;
  stage: ReturnType<typeof draftingStage>;
}) {
  const { gen, drafts } = session;
  const activity = gen.progress?.progress ?? null;
  const ownDrafts = drafts.length - session.tags.size;
  const live = stage === "queued" || stage === "reading" || stage === "drafting";
  const lines = (activity?.recent ?? []).filter((l): l is string => typeof l === "string" && l.trim() !== "");
  return (
    <>
      <DraftingStage activity={activity} status={gen.status} drafted={ownDrafts} frames={session.frames} />
      {live ? (
        <WorkCalm
          line={calmLine({ stage, reads: activity?.reads ?? 0, drafted: ownDrafts, sources: session.sources })}
          file={stage === "queued" ? null : newestFile(activity)}
        />
      ) : null}
      <ExplorationPassCard session={session} projectName={project.name} />
      <ConversationFeed board={session.board} screens={session.pass.requestId ? session.pass.screens : undefined} />
      {/* The stage above carries the counters (files read, searches, drafted); the log is the lines. */}
      <WorkLog lines={lines} live={live} open={live} />
      <CodeOutcome session={session} />
    </>
  );
}

/** The done view's summary for a drafting job: how many were accepted of those drafted, what
 * areas they cover, what Orcha read to write them. */
function DraftingSummary({ session, name }: { session: DraftingSession; name: string }) {
  const { gen, drafts, acceptedIds } = session;
  const activity = gen.progress?.progress ?? null;
  const drafted = session.drafted;
  const categories = draftAreas(drafts, gen.progress?.summary?.categories);
  const max = Math.max(1, ...categories.map(([, n]) => n));
  const verdict =
    drafted === 0
      ? "Nothing was drafted"
      : `${drafted} drafted${name === "Draft the gaps" ? " for the gaps on the map" : ""}`;
  return (
    <WorkSummary
      ring={<CountRing value={acceptedIds.length} of={Math.max(drafts.length, drafted)} label="accepted" />}
      verdict={
        <span className="flex flex-col gap-0.5">
          <span>{verdict}</span>
          <span className="text-sm font-normal text-muted">
            {acceptedIds.length === 0 ? "Review each one below: accept, edit or dismiss." : `${acceptedIds.length} accepted so far. Run them from the bar at the bottom.`}
          </span>
        </span>
      }
      aside={
        categories.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Drafts by area" data-drafting-areas>
            {categories.map(([c, n]) => (
              <li key={c} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium text-fg">{c}</span>
                  <span className="ml-auto text-xs tabular text-muted">{n}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : null
      }
      tiles={[
        { label: "Drafted", value: String(drafted) },
        { label: "Accepted", value: String(acceptedIds.length) },
        { label: "Files read", value: String(activity?.reads ?? 0) },
        { label: "Searches", value: String(activity?.searches ?? 0) },
      ]}
    />
  );
}

/** Why the drafting from code ended early, when it failed or was stopped. */
function CodeOutcome({ session }: { session: DraftingSession }) {
  const { gen, codePhase } = session;
  if (codePhase === "failed") {
    return (
      <StatusLine status="fail" className="rounded-lg border border-border bg-panel px-3.5">
        <span>{gen.progress?.error ?? "The agent could not finish drafting."}</span>
      </StatusLine>
    );
  }
  if (codePhase === "cancelled") {
    return (
      <StatusLine status="cancelled" className="rounded-lg border border-border bg-panel px-3.5">
        Stopped. Drafts written before the stop stay for review.
      </StatusLine>
    );
  }
  return null;
}

/** The facts of the run, in the row under the title: what is read, from where, where it runs. */
function RunFacts({ session, detail, agent }: { session: DraftingSession; detail: SessionDetail; agent: string | null }) {
  const { pass } = session;
  const s = detail.session;
  const choice: DraftChoice = pass.requestId ? "new" : session.sources === "code" ? "code" : "past";
  return (
    <WorkFacts>
      <WorkFact label="Reading">{session.sources !== "exploration" || choice !== "past" ? CHOICE_LABEL[choice] : "Past explorations"}</WorkFact>
      {choice === "past" && session.explorations ? (
        <WorkFact label="Explorations">
          {session.explorations.count === 0
            ? "None completed yet"
            : `${Math.min(3, session.explorations.count)} of ${session.explorations.count} read`}
        </WorkFact>
      ) : null}
      {pass.explore ? (
        <>
          <WorkFact label="Explores on">
            <RunPlacement placement={runPlacement({ kind: pass.explore.target_kind, device: pass.explore.device ?? null, deviceName: pass.explore.run?.deviceName ?? null })} />
          </WorkFact>
          {pass.explore.locator ? (
            <WorkFact label="App" mono title={pass.explore.locator}>
              {pass.explore.locator}
            </WorkFact>
          ) : null}
        </>
      ) : s.app_id ? (
        <WorkFact label="Runs on" title={s.app_id}>
          <PlatformIcon kind={s.platform} />
          <span className="shrink-0">{PLATFORM_LABELS[s.platform]}</span>
          <span className="truncate font-mono">{s.app_id}</span>
        </WorkFact>
      ) : null}
      {agent ? <WorkFact label="Agent">{agent}</WorkFact> : null}
    </WorkFacts>
  );
}

/** The drafts: their counts, then the review deck. */
function DraftsSection({ session }: { session: DraftingSession }) {
  const { drafts, acceptedIds } = session;
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-3" id="drafting-drafts" data-drafting-drafts>
      <WorkHeading
        title="Drafts"
        count={
          drafts.length > 0 ? (
            <span data-drafting-counts>
              {drafts.length} drafted · {acceptedIds.length} accepted
              {session.tags.size > 0 ? ` · ${session.tags.size} from the exploration` : ""}
            </span>
          ) : null
        }
      />
      <div className="rounded-lg border border-border bg-panel p-4 max-[720px]:p-3">
        <DraftReview session={session} editHref={(id) => qaHref({ view: "scenarios", platform: session.platform === "ios" ? null : session.platform, scenario: id })} skeletons={4} />
      </div>
    </div>
  );
}
