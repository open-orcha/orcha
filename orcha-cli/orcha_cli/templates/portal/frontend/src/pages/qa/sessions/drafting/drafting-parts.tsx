import type { ReactNode } from "react";
import { Compass } from "../../map/kit/icons";
import { Link, StatusGlyph, cn, type GlyphStatus, PLATFORM_LABELS, PlatformIcon } from "../../map/kit";
import { qaHref } from "../../parts";
import { useNow } from "../detail/phase-timeline";
import { canStartChoice, draftChoiceOptions, explorationKindsLine, explorationPassLine, isOpenPassStage, isPassSettingUp, type DraftChoice, type ExplorationPassStage, type ExplorationSummary } from "./lib/draft-sources";
import { DraftDeck } from "./draft-deck";
import { splitFrame } from "./drafting-split";
import { DraftSkeletons } from "./generation-activity";
import { ExplorationReplay, FrameView, LiveDevicePeek } from "./live-device-peek";
import { runPlacement } from "./run-placement";
import { StatusLine } from "./status-line";
import type { DraftingSession } from "./use-drafting-session";

/** What the picker reads and sets. */
export interface DraftSourcesState {
  choice: DraftChoice;
  setChoice: (c: DraftChoice) => void;
  explorations: ExplorationSummary | null;
  hasRepo: boolean;
  hasTarget: boolean;
}

/**
 * "Draft from": the code only, the code plus the past explorations (with what exists:
 * "9 explorations · last Oct 3 on Web"), or the code plus a new exploration. In Run check, whose
 * task then states what to read.
 */
export function DraftSourcesPicker({
  session,
  repoUrl = null,
  newExploration,
  plain = false,
}: {
  session: DraftSourcesState;
  /** Only the choice, without the line above it. */
  plain?: boolean;
  repoUrl?: string | null;
  /** What "Code + a new exploration" shows when picked; by default how the two work together. */
  newExploration?: ReactNode;
}) {
  const { choice, setChoice, explorations, hasRepo, hasTarget } = session;
  const options = draftChoiceOptions({ hasRepo, explorations, hasTarget });
  const kinds = explorationKindsLine(explorations);
  const canGenerate = canStartChoice(choice, { hasRepo, explorations, hasTarget });
  return (
    <div className="flex flex-col gap-2" data-generate-sources data-draft-choice-selected={choice}>
      {plain ? null : <p className="text-sm text-muted">
        Embodent drafts outcome-based scenarios you review before anything runs
        {repoUrl ? (
          <>
            , reading <span className="break-all font-mono text-fg">{repoUrl}</span>
          </>
        ) : null}
        .
      </p>}
      <span className="text-xs font-medium text-fg-2" id="draft-from-label">
        Draft from
      </span>
      <div
        role="radiogroup"
        aria-labelledby="draft-from-label"
        className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border"
      >
        {options.map((o) => {
          const selected = choice === o.value;
          return (
            <div
              key={o.value}
              className={cn(selected && "bg-selected")}
              data-draft-choice-row={o.value}
              // The whole row selects: a click on the label or its detail lands on the row even
              // where the radio button's box does not reach.
              onClick={(e) => {
                if (o.disabled || selected) return;
                if ((e.target as HTMLElement).closest("[data-draft-new-exploration]")) return;
                setChoice(o.value);
              }}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={o.disabled}
                onClick={() => setChoice(o.value)}
                className={cn(
                  "flex w-full cursor-pointer select-none items-start gap-2.5 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  o.disabled ? "cursor-not-allowed opacity-60" : !selected && "hover:bg-hover",
                )}
                data-draft-choice={o.value}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-fg" : "border-border-strong",
                  )}
                >
                  {selected ? <span className="size-2 rounded-full bg-fg" /> : null}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">{o.label}</span>
                  <span className="text-xs text-muted" data-generate-explorations={o.value === "past" ? "" : undefined}>
                    {o.detail}
                  </span>
                  {o.value === "past" && kinds ? <span className="text-xs text-muted">{kinds}</span> : null}
                </span>
              </button>
              {o.value === "new" && selected && !o.disabled ? (
                newExploration ? (
                  <div className="px-3 pb-3" data-draft-new-exploration data-draft-new-exploration-composer>
                    {newExploration}
                  </div>
                ) : (
                  <NewExplorationHandoff />
                )
              ) : null}
            </div>
          );
        })}
      </div>
      {!canGenerate ? (
        <div data-generate-needs-repo>
          <StatusLine status="warning">
            {!hasRepo && !hasTarget
              ? "Add a repository or a platform to the project first."
              : choice === "code"
                ? "Add a repository (git URL or local path) to the project first."
                : choice === "past"
                  ? "No explorations yet: draft from a new one instead."
                  : "Add a platform to the project to explore it."}
          </StatusLine>
        </div>
      ) : null}
    </div>
  );
}

/** "Code + a new exploration": the explorer and the drafter work in one task. */
function NewExplorationHandoff() {
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-3 pl-9" data-draft-new-exploration data-draft-new-exploration-handoff>
      <p className="text-xs text-fg-2">
        The agent explores for the minutes you give it, then drafts in the same task.
      </p>
    </div>
  );
}

/** Before it starts: what the job will read and how long it usually takes. */
export function StartHint({ session }: { session: DraftSourcesState }) {
  const { choice, explorations, hasRepo } = session;
  if (choice === "new") return null;
  const reads = [
    hasRepo ? "the code" : null,
    choice === "past" && explorations && explorations.count > 0 ? `the ${Math.min(3, explorations.count)} newest explorations` : null,
  ].filter((x): x is string => Boolean(x));
  if (reads.length === 0) return null;
  const list = reads.length === 1 ? reads[0] : `${reads.slice(0, -1).join(", ")} and ${reads[reads.length - 1]}`;
  return (
    <p className="text-xs text-muted" data-draft-start-hint>
      Embodent reads {list}. The first drafts usually land within a few minutes; a full pass takes 5 to 15.
    </p>
  );
}

const PASS_GLYPH: Record<ExplorationPassStage, GlyphStatus> = {
  queued: "queued",
  exploring: "running",
  handoff: "running",
  drafting: "running",
  done: "pass",
  "draft-failed": "fail",
  skipped: "warning",
  failed: "fail",
  cancelled: "cancelled",
};

/**
 * The new exploration on the page: its status line ("Exploring FleetMate on Web · 3 screens ·
 * 2:10 of 5:00", then "Drafting from the new exploration…"), the live device view while it
 * walks, and why nothing was drafted from it when it failed or was skipped.
 */
export function ExplorationPassCard({
  session,
  projectName,
  fit = false,
  className,
}: {
  session: DraftingSession;
  projectName: string;
  /** The side-by-side review: fill the column's height, the device scaled to fit it. */
  fit?: boolean;
  className?: string;
}) {
  const { pass, drafts } = session;
  const now = useNow(true);
  if (!pass.requestId) return null;
  const e = pass.explore;
  const stage = pass.stage;
  const drafted = pass.followUpId ? drafts.filter((d) => d.generation_request_id === pass.followUpId).length : 0;
  const line = e
    ? explorationPassLine({ e, followUp: pass.followUp, projectName, screens: pass.screens, drafted, now })
    : "Loading the exploration…";
  const quiet = stage === "failed" || stage === "skipped" || stage === "draft-failed" || stage === "cancelled";
  // Getting the device ready: nothing on it yet.
  const settingUp = e != null && isPassSettingUp(e);
  // Where the exploration runs, from its own request and run: never the page's device, which
  // can be another platform's (the iOS pick read "Exploring on iPhone 17 Pro" for a Web run).
  const placement = e ? runPlacement({ kind: e.target_kind, device: e.device ?? null, deviceName: e.run?.deviceName ?? null }) : null;
  const live = Boolean(e?.run_id && stage === "exploring" && !settingUp && placement);
  // An iPad / Android tablet exploration gets a wider card: its frame is near-square.
  const tabletPass = splitFrame(e?.target_kind, { deviceName: placement?.isDefault ? null : placement?.device }) === "tablet";
  const ended =
    Boolean(e?.run_id && placement && stage !== "exploring" && stage !== "queued") &&
    (pass.frames.length > 0 || Boolean(e?.run?.blockerTitle));
  const blocker = e?.run?.blockerTitle ? { title: e.run.blockerTitle, frame: e.run.blockerFrame ?? null } : null;
  const statusLine = (
    <>
      <ExplorationSiblingsStrip session={session} />
      <p className="flex items-start gap-2 text-sm text-fg" aria-live="polite" data-explore-line>
        <StatusGlyph status={stage ? PASS_GLYPH[stage] : "pending"} size={14} decorative className="mt-0.5" />
        <span className={cn("min-w-0", quiet && "text-fg-2")}>{line}</span>
      </p>
    </>
  );

  if (fit) {
    // The side-by-side review's left column: the device fills the height, the status under it.
    return (
      <div
        className={cn("flex h-full min-h-0 flex-col gap-2.5 rounded-lg border border-border bg-panel p-3.5", className)}
        role="group"
        aria-label="New exploration"
        data-drafting-explore
        data-explore-stage={stage ?? "loading"}
        data-explore-fit
      >
        {live && e?.run_id && placement ? (
          <LiveDevicePeek
            runId={e.run_id}
            placement={placement}
            frames={pass.frames}
            actionCount={pass.actions}
            device={e.device}
            fit
            caption={statusLine}
          />
        ) : ended && e?.run_id && placement ? (
          <ExplorationReplay
            runId={e.run_id}
            placement={placement}
            frames={pass.frames}
            blocker={blocker}
            device={e.device}
            fit
            caption={statusLine}
          />
        ) : (
          <>
            {placement && isOpenPassStage(stage) ? (
              // Queued or setting up: the device's outline, waiting for its first screen.
              <FrameView placement={placement} path={null} device={e?.device} fit />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted">
                <Compass className="size-8 opacity-40" strokeWidth={1.25} aria-hidden />
              </div>
            )}
            {statusLine}
            {stage === "queued" ? (
              <p className="text-xs text-muted" data-explore-pending>
                The device view appears as soon as the agent starts it. You can leave this page: the agent keeps
                working.
              </p>
            ) : null}
            {e?.run_id ? (
              <Link href={qaHref({ view: "sessions", session: e.run_id })} className="self-start text-xs text-muted hover:text-fg" data-explore-run-link>
                Open exploration
              </Link>
            ) : null}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-3 rounded-lg border border-border bg-panel p-3.5", className)}
      data-drafting-explore
      data-explore-stage={stage ?? "loading"}
    >
      <div className="flex items-center gap-2">
        <Compass className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
        <h2 className="text-sm font-semibold text-fg">New exploration</h2>
        {e?.run_id && (stage !== "exploring" || settingUp) ? (
          <Link href={qaHref({ view: "sessions", session: e.run_id })} className="ml-auto text-xs text-muted hover:text-fg" data-explore-run-link>
            Open exploration
          </Link>
        ) : null}
      </div>
      {statusLine}
      {stage === "queued" ? (
        <p className="text-xs text-muted" data-explore-pending>
          The device view appears as soon as the agent starts it. You can leave this page: the agent keeps working.
        </p>
      ) : null}
      {live && e?.run_id && placement ? (
        <LiveDevicePeek
          runId={e.run_id}
          placement={placement}
          frames={pass.frames}
          actionCount={pass.actions}
          device={e.device}
          className={cn("w-full", e.target_kind === "web" ? "" : tabletPass ? "mx-auto max-w-[520px]" : "mx-auto max-w-[340px]")}
        />
      ) : ended && e?.run_id && placement ? (
        <ExplorationReplay
          runId={e.run_id}
          placement={placement}
          frames={pass.frames}
          blocker={blocker}
          device={e.device}
          className={cn("w-full", e.target_kind === "web" ? "" : tabletPass ? "mx-auto max-w-[520px]" : "mx-auto max-w-[340px]")}
        />
      ) : null}
    </div>
  );
}

const SIBLING_GLYPH: Record<string, GlyphStatus> = {
  queued: "queued",
  running: "running",
  completed: "pass",
  failed: "fail",
  cancelled: "cancelled",
};

/** Several platforms explored at once: a tab per platform, its status, choosing which one the
 * card shows. Nothing for a single exploration. */
function ExplorationSiblingsStrip({ session }: { session: DraftingSession }) {
  const { siblings, viewedExploreId } = session;
  if (siblings.length < 2) return null;
  return (
    <div role="tablist" aria-label="Explorations by platform" className="flex flex-wrap gap-1.5" data-explore-siblings>
      {siblings.map((r) => {
        const selected = r.id === viewedExploreId;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => session.setViewedExploreId(r.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&_svg]:size-3.5",
              selected ? "border-primary/50 bg-primary/10 text-fg" : "border-border text-fg-2 hover:bg-hover",
            )}
            data-explore-sibling={r.target_kind}
            data-explore-sibling-status={r.status}
          >
            <PlatformIcon kind={r.target_kind} />
            {PLATFORM_LABELS[r.target_kind] ?? r.target_kind}
            <StatusGlyph status={SIBLING_GLYPH[r.status] ?? "pending"} size={11} decorative />
          </button>
        );
      })}
    </div>
  );
}

/** The drafts: skeletons until the first one lands, then the review deck. */
export function DraftReview({
  session,
  editHref,
  skeletons = 3,
}: {
  session: DraftingSession;
  editHref?: (id: string) => string;
  skeletons?: number;
}) {
  const { drafts, revisions, actions, gen } = session;
  if (drafts.length === 0) {
    return gen.open || isOpenPassStage(session.pass.stage) ? (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted" data-generation-empty>
          {gen.requestId
            ? "Drafts appear here as Embodent writes them."
            : "Drafts appear here once the exploration is done and Embodent drafts from it."}
        </p>
        <DraftSkeletons count={skeletons} />
      </div>
    ) : (
      <p className="text-sm text-muted" data-generation-empty>
        No scenarios were drafted.
      </p>
    );
  }
  return (
    <DraftDeck
      drafts={drafts}
      pendingIds={revisions.pendingIds}
      errors={revisions.errors}
      feedbackDrafts={actions.feedbackDrafts}
      onFeedbackChange={actions.setFeedback}
      onRevise={session.reviseOne}
      onAccept={session.acceptOne}
      onDiscard={actions.discardOne}
      onAcceptAll={session.acceptAll}
      onAcceptRemaining={session.acceptRemaining}
      recentlyUpdatedIds={session.recentlyUpdated}
      editHref={editHref}
      tags={session.tags}
      evidence={session.board.evidence}
      versions={session.board.versions}
      positionKey={gen.requestId ?? gen.exploreRequestId}
      auth={session.auth}
    />
  );
}

/** The request's error, if any. */
export function DraftingError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" data-generate-error>
      <StatusLine status="fail">{error}</StatusLine>
    </div>
  );
}
