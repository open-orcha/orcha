import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowLeft, ArrowUpRight, Columns2, Copy, Pin, PinOff, RotateCcw, Square } from "../../map/kit/icons";
import { Tooltip } from "../../../../components/primitives";
import { Button, Link, Skeleton, useConfirm, useRouter, useToast } from "../../map/kit";
import { Md } from "../../../../components/ui";
import { FrameShapeProvider, Filmstrip } from "../../Frames";
import type { QaNav } from "../../QaPage";
import type { QaAuthority } from "../../authority";
import { errText, useAgentAlias } from "../../parts";
import { verdictWord } from "../../qaWords";
import { isMobileViewport, type QaVerdict } from "../../qaApi";
import { WorkPhaseBar } from "../work/phase-bar";
import { WorkTitle } from "../work/work-title";
import { WorkPage, WorkSection } from "../work/work-done";
import { WorkHeading, WorkEmpty, WorkLive } from "../work/work-live";
import { explorationDoing, explorationPhase, explorationWorkStatus, fmtClock as clockLine, phasesFor, type WorkStatus } from "../work/words";
import { frameKind, reproOf } from "../adapt";
import { duplicateSession, keepSession, runSessionAgain, stopSession } from "../api";
import { runPlacement } from "../frames";
import { CheckFace, checksBy } from "./check-face";
import { ExploreCharter, FindingsRail, LiveScreen, liveFrameClass } from "./explore-face";
import { DraftsPanel, draftsPanelMode } from "./drafts-panel";
import { type FindingActions } from "./finding-actions";
import { EditableName, ExplorationFacts, ExplorationGoal } from "./header";
import { exampleFeatureOf, isRunningFace, phaseClock, queuedWords, selectFace, tookSeconds } from "./model";
import { useNow } from "./phase-timeline";
import { LegacyReport } from "./legacy";
import { ExplorationReport } from "./report";
import { EndedFace, QueuedFace } from "./states";
import { StudyFace } from "./study-face";
import { useSessionLive } from "./use-session-live";
import { WorkflowSection } from "../workflows/workflow-section";
import { ActivityPanel, RunWatch } from "../../run/ActivityPanel";
import { CardMenu, type MenuItem } from "../home/card-menu";
import { type DraftedRef, scenarioHref, useFindingScenarios } from "../findings/finding-scenario-button";
import { checkTally } from "../../runs/adapt";
import { ExplorationRunLinks, currentRunLinks } from "./run-links";
import { compareHref, runHref } from "../links";
import { ExplorationMap } from "../walked/exploration-map";
import { DraftingWorkspace } from "../drafting/drafting-workspace";

/** A check run's verdicts, one line per criterion, grouped by scenario, with their screenshots. */
function CheckVerdicts({ verdicts }: { verdicts: readonly QaVerdict[] }) {
  const groups = checksBy(verdicts);
  return (
    <WorkSection title="Checks" id="checks" count={verdicts.length}>
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <section key={g.id} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3" data-check-scenario={g.id}>
            <h3 className="text-sm font-medium text-fg">{g.name}</h3>
            <ul className="flex flex-col gap-1">
              {g.rows.map((v) => (
                <li key={v.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-fg-2" data-verdict={v.verdict}>
                  <span>Criterion {v.criterion_index + 1}: {verdictWord(v.verdict)}</span>
                  {v.note ? <span className="text-xs text-muted">{v.note}</span> : null}
                </li>
              ))}
            </ul>
            <Filmstrip label="Check screenshots" frames={g.rows.flatMap((v) => (v.frame_ids ?? []).map((id) => ({ id, caption: `Criterion ${v.criterion_index + 1}: ${verdictWord(v.verdict)}` })))} />
          </section>
        ))}
      </div>
    </WorkSection>
  );
}

/**
 * One session, in place of the home: mission control while it runs (a phase bar over the Study,
 * Explore or Check face), its report once it is done, a clear ended state when it failed or was
 * stopped. A drafting session has its own view in the same frame.
 */
export function ExplorationDetail({ cid, id, nav, auth }: { cid: string; id: string; nav: QaNav; auth: QaAuthority }) {
  const { detail, steps, flows, live, error, reload } = useSessionLive(cid, id, nav.nonce);
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const session = detail?.session ?? null;
  const agent = useAgentAlias(session?.agent_id, session?.agent_alias);
  const onChanged = useCallback(() => {
    reload();
    nav.refresh();
  }, [reload, nav]);
  const actor = auth.human?.id ?? null;
  // A stored finding keeps its draft: "Open scenario" after a reload.
  const knownDrafts = useMemo(() => {
    const out: Record<string, DraftedRef> = {};
    for (const f of live?.findings ?? []) {
      const sid = f.qa.scenario_id;
      if (!sid) continue;
      const row = detail?.drafts.find((d) => d.id === sid);
      out[`finding:${f.qa.session_id}:${f.seq}`] = { id: sid, name: row?.name ?? f.title, href: scenarioHref(session?.platform ?? null, sid) };
    }
    return out;
  }, [live, detail, session]);
  const scenarios = useFindingScenarios(cid, actor, knownDrafts, onChanged);
  const actions = useMemo<FindingActions>(
    () => ({ auth, onChanged, scenarios, explorationId: id, platform: session?.platform ?? null }),
    [auth, onChanged, scenarios, id, session?.platform],
  );
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  const back = (
    <button type="button" onClick={() => nav.goBack({ session: null })} className="qa-back" data-back-to-explorations data-qa-back>
      <ArrowLeft className="size-3.5" /> {nav.get("from") != null ? "Back" : "All runs"}
    </button>
  );

  const running = session?.status === "running";
  const now = useNow(running);

  if (!detail || !session || !live) {
    return (
      <WorkPage data-session-loading>
        {back}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </WorkPage>
    );
  }

  const gate = (node: ReactNode) => (auth.can ? node : <Tooltip label={auth.reason || "Only a person can start QA work"} placement="bottom">{node as never}</Tooltip>);
  // Run again and Duplicate queue the same work; the page moves to the new session.
  const repeat = async (key: "again" | "duplicate", fn: typeof runSessionAgain, failTitle: string) => {
    setBusy(key);
    try {
      const next = await fn(session.id, actor);
      nav.refresh();
      nav.set({ session: next.id });
    } catch (e) {
      toast({ title: failTitle, description: errText(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  };
  const againButton = gate(
    <Button variant="primary" disabled={!auth.can} loading={busy === "again"} onClick={() => void repeat("again", runSessionAgain, "Could not start it again")} data-action="again">
      <RotateCcw /> Run again
    </Button>,
  );
  const stop = async () => {
    const ok = await confirm({
      title: "Stop this exploration?",
      description: "Embodent ends the session where it is. What it found so far is kept.",
      confirmLabel: "Stop exploration",
      cancelLabel: "Keep going",
      destructive: true,
    });
    if (!ok) return;
    setBusy("cancel");
    try {
      await stopSession(session.id, actor);
      onChanged();
    } catch (e) {
      toast({ title: "Could not stop it", description: errText(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  };
  const stopButton = gate(
    <Button variant="danger" disabled={!auth.can} loading={busy === "cancel"} onClick={() => void stop()} data-action="cancel">
      <Square /> Stop
    </Button>,
  );
  const walkedMap =
    steps.some((s) => s.frame_id) && !running ? (
      <WorkSection title="The screens it walked" id="walked">
        <div className="flex h-[min(64vh,640px)] min-h-0 flex-col overflow-hidden rounded-lg border border-border">
          <ExplorationMap steps={steps} findings={detail.findings} kind={frameKind(session)} />
        </div>
      </WorkSection>
    ) : null;
  const shape = session.platform === "web" && !isMobileViewport(session.device_name) ? "wide" : "phone";

  if (session.kind === "draft") {
    return (
      <FrameShapeProvider shape={shape}>
        <DraftingWorkspace cid={cid} detail={detail} agent={agent} back={back} primary={running ? stopButton : againButton} onRunCheck={(ids) => nav.runQa("check", null, { platform: session.platform, scenarioIds: [...ids] })} auth={auth} nonce={nav.nonce} onReload={reload} />
      </FrameShapeProvider>
    );
  }

  const base = live.exploration;
  // A rename shows at once; the row's own read replaces it.
  const e = renamed && renamed.from === base.name ? { ...base, name: renamed.to } : base;
  const face = selectFace(e);
  const faceRunning = isRunningFace(face);
  const draftsMode = draftsPanelMode(detail.drafts.length, face);
  const kind = frameKind(session);
  const placement = runPlacement({ kind });
  const status: WorkStatus = explorationWorkStatus(e.status);
  const phases = phasesFor(detail.drafts.length ? "exploration-drafts" : "exploration");
  const clock = phaseClock(e, now);
  const caption = clock.elapsedS != null ? `${clockLine(clock.elapsedS)}${clock.capS ? ` / ${clockLine(clock.capS)}` : ""}` : null;
  const ended = face === "ended";
  const repro = Object.fromEntries(live.findings.map((f) => [f.id, reproOf(f, steps)]));
  const counters = `${live.steps} ${live.steps === 1 ? "step" : "steps"} · ${live.findings.length} ${live.findings.length === 1 ? "finding" : "findings"}`;
  const drafts = draftsMode ? <DraftsPanel drafts={detail.drafts} platform={session.platform} compact={draftsMode === "debrief"} onRunCheck={auth.can ? () => nav.runQa("check", null, { platform: session.platform, scenarioIds: detail.drafts.filter((d) => d.status === "validated").map((d) => d.id) }) : undefined} /> : null;
  // The walk in progress, the ranked queue, each walk's outcome and the App model, beside the
  // classic faces. The walks are the explorer's work, so they lead once it explores; while it
  // reads (or waits) the study comes first and the teaching scene follows.
  const workflows =
    session.kind === "explore" || detail.walks.length > 0 ? (
      <WorkflowSection cid={cid} platform={session.platform} appName={session.app_id ?? "this app"} detail={detail} flows={flows} live={faceRunning} kind={kind} exampleFeature={exampleFeatureOf(e)} />
    ) : null;
  const workflowFirst = faceRunning && face !== "study" && face !== "queued";
  const queue = detail.queue ?? { position: null, waiting: null };
  const openRun = <ExplorationRunLinks links={currentRunLinks([], { explorationId: e.id, runId: face === "queued" ? null : e.run_id, kind, running: faceRunning })} />;
  // More: the secondary actions, in one menu on every job page.
  const moreItems: MenuItem[] = [];
  if (face === "report") {
    moreItems.push({ key: "duplicate", label: "Duplicate", icon: <Copy />, disabled: busy === "duplicate" || !auth.can, onSelect: () => void repeat("duplicate", duplicateSession, "Could not duplicate it") });
    if (session.previous_session_id) {
      const prev = session.previous_session_id;
      moreItems.push({ key: "compare", label: "Compare with previous", icon: <Columns2 />, onSelect: () => router.push(compareHref(prev, e.id)) });
    }
  }
  const keep = async (patch: Parameters<typeof keepSession>[2], failTitle: string, then?: () => void) => {
    try {
      await keepSession(session.id, actor, patch);
      onChanged();
      then?.();
    } catch (err) {
      toast({ title: failTitle, description: errText(err), variant: "error" });
    }
  };
  moreItems.push({
    key: "pin",
    label: session.pinned_at ? "Unpin" : "Pin",
    icon: session.pinned_at ? <PinOff /> : <Pin />,
    disabled: !auth.can,
    onSelect: () => void keep({ pinned: !session.pinned_at }, "Could not change it"),
  });
  if (!faceRunning) {
    const archived = session.archived_at != null;
    moreItems.push({
      key: "archive",
      label: archived ? "Unarchive" : "Archive",
      icon: archived ? <ArchiveRestore /> : <Archive />,
      disabled: !auth.can,
      onSelect: async () => {
        if (archived) return void keep({ archived: false }, "Could not change it");
        const ok = await confirm({ title: "Archive this exploration?", description: "It leaves the history list. Its report is kept.", confirmLabel: "Archive" });
        if (ok) void keep({ archived: true }, "Could not archive it", () => nav.set({ session: null }));
      },
    });
  }
  const more = <CardMenu label="More actions" items={moreItems} />;
  const checks = detail.verdicts.length ? <CheckVerdicts verdicts={detail.verdicts} /> : null;
  const measured = <LegacyReport cid={cid} detail={detail} steps={steps} />;
  const walked = (
    <>
      {measured}
      {walkedMap}
    </>
  );
  const open = live.findings.filter((f) => f.qa.status !== "dismissed");
  const dismissed = live.findings.filter((f) => f.qa.status === "dismissed");
  const full = session.report_md ? (
    <details className="group" data-full-report>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm font-medium text-fg-2 hover:text-fg">Full report</summary>
      <Md className="wk-text wk-md qa-report" text={session.report_md} />
    </details>
  ) : null;

  let liveView: ReactNode = null;
  if (faceRunning) {
    let sees: ReactNode;
    let produces: ReactNode;
    if (face === "queued") {
      sees = <QueuedFace queue={queue} />;
      produces = (
        <section className="flex flex-col gap-2" aria-label="Findings so far" data-findings-rail>
          <WorkHeading title="Findings" count={0} />
          <WorkEmpty live skeletons={3}>
            Findings land here the moment Embodent finds them, beside the charter it writes while it reads.
          </WorkEmpty>
        </section>
      );
    } else if (face === "study") {
      sees = <StudyFace part="sees" exploration={e} screens={live.screens} frames={live.frames} placement={placement} />;
      produces = <StudyFace part="produces" exploration={e} screens={live.screens} frames={live.frames} placement={placement} />;
    } else if (face === "explore") {
      sees = <LiveScreen live={live} placement={placement} runId={e.run_id} session={session} auth={auth} frameClassName={liveFrameClass(placement)} />;
      produces = (
        <>
          {e.charter.length ? <ExploreCharter exploration={e} /> : null}
          <FindingsRail exploration={e} findings={live.findings} runId={e.run_id} />
        </>
      );
    } else {
      sees = <LiveScreen live={live} placement={placement} runId={e.run_id} session={session} auth={auth} frameClassName={liveFrameClass(placement)} />;
      produces = (
        <>
          <CheckFace live={live} verdicts={detail.verdicts} measured={detail.measured ?? []} />
          <FindingsRail exploration={e} findings={live.findings} runId={e.run_id} />
        </>
      );
    }
    liveView = (
      <RunWatch sessionId={session.id}>
        <WorkLive
          // The study and explore faces span both columns; queued and check carry their own.
          data-face={face === "study" || face === "explore" ? face : undefined}
          sees={sees}
          produces={
            <>
              <ActivityPanel auth={auth} counters={counters} />
              {produces}
              {drafts}
            </>
          }
        />
      </RunWatch>
    );
  }

  return (
    <FrameShapeProvider shape={shape}>
      <WorkPage data-exploration-detail={e.id} data-detail-face={face}>
        {back}
        <WorkTitle
          name={<EditableName key={e.name} id={e.id} name={e.name} actor={actor} canRename={auth.can} onRenamed={(to) => setRenamed({ from: base.name, to })} />}
          status={status}
          doing={explorationDoing(e.status, e.recipe)}
          waiting={face === "queued" ? queuedWords(queue).title : null}
          startedAt={e.started_at}
          endedAt={e.finished_at}
          durationS={faceRunning ? null : tookSeconds(e)}
          primary={faceRunning ? stopButton : againButton}
          openRun={openRun}
          more={more}
          facts={<ExplorationFacts exploration={e} kind={session.platform} session={session} agent={agent} />}
        >
          <ExplorationGoal goal={e.goal} />
        </WorkTitle>

        {!ended ? <WorkPhaseBar phases={phases} exploreWord={e.recipe === "map" ? "Map" : e.recipe === "check" ? "Check" : undefined} current={explorationPhase(e.status)} caption={faceRunning ? caption : null} fraction={faceRunning ? clock.fraction : null} /> : null}

        {workflowFirst ? workflows : null}
        {liveView}
        {faceRunning && !workflowFirst ? workflows : null}
        {face === "report" ? (
          <ExplorationReport
            checked={session.kind === "check" ? checkTally(detail.verdicts) : null}
            exploration={e}
            runFindings={open}
            repro={repro}
            steps={live.steps}
            actions={actions}
            onRun={nav.runQa}
            drafts={drafts}
            walks={workflows}
            checks={checks}
            walked={walked}
            dismissed={dismissed}
            full={full}
          />
        ) : null}
        {ended ? (
          <EndedFace exploration={e}>
            {drafts}
            {e.result ? <ExplorationReport checked={session.kind === "check" ? checkTally(detail.verdicts) : null} exploration={e} runFindings={open} repro={repro} steps={live.steps} actions={actions} onRun={nav.runQa} walks={workflows} checks={checks} walked={walked} dismissed={dismissed} /> : workflows}
          </EndedFace>
        ) : null}

        {faceRunning ? null : (
          <RunWatch sessionId={session.id}>
            <ActivityPanel auth={auth} counters={counters} />
          </RunWatch>
        )}

        {face === "report" && e.run_id ? (
          <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm text-muted">
            <span>Every step is in the run.</span>
            <Link href={runHref(e.run_id)} className="inline-flex items-center gap-0.5 text-fg-2 hover:text-fg">
              Watch the replay <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          </footer>
        ) : null}
      </WorkPage>
    </FrameShapeProvider>
  );
}
