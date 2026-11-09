/**
 * An onboarding pass between the click and its session: the phase creates a task, and the session
 * only exists once the agent calls start_session. Starting a run still lands here, on the live
 * page, saying what is happening; it moves to the run itself the moment there is a session.
 * What can go wrong here shows here: no agent, a blocked agent, a worker that never came.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Skeleton } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import type { MapAction, OnboardingMap } from "../onboarding/contract";
import { failureText, livePlatformOf, retryDepth } from "../onboarding/live-pass";
import { useOnboardingMap } from "../onboarding/use-onboarding-map";
import { getQaSettings } from "../requests/api";
import { qaAgentOf } from "../requests/model";
import { getQaSetup, NO_AGENT } from "../setup/setup";
import { SetupGate } from "../setup/SetupGate";
import { useLoad } from "../parts";
import { ActivityPanel, RunLogProvider } from "./ActivityPanel";
import { runHref, type RunPass } from "./runFlow";
import { useRunLog } from "./useRunLog";

const PASS_TITLE: Record<RunPass, string> = { live: "Mapping your app", bring_in: "Drafting for the gaps", first_run: "Running your first test" };

/** What Run again sends for this pass. */
function retry(pass: RunPass, map: OnboardingMap): { action: MapAction; options: object } {
  if (pass === "live") return { action: "run_live", options: { depth: retryDepth(map.live_run), platform: livePlatformOf(map) } };
  if (pass === "bring_in") return { action: "bring_in", options: { migrate: false, draft: true, gap_screen_ids: map.bring_in.draft.gap_screen_ids } };
  return { action: "first_run", options: {} };
}

export function PendingRun({ cid, auth, pass, from, onLeave }: {
  cid: string;
  auth: QaAuthority;
  pass: RunPass;
  from: string | null;
  onLeave: () => void;
}) {
  const { snap } = useSnapshot();
  const navigate = useNavigate();
  const { map, act, busy, refresh } = useOnboardingMap(cid);
  const setup = useLoad((s) => getQaSetup(cid, s), [cid]);
  const phase = map?.phases[pass] ?? null;
  const taskId = phase?.task_id ?? null;
  const moved = useRef(false);
  const settings = useLoad((s) => getQaSettings(cid, s), [cid]).data;
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const agent = agents.find((a) => a.id === map?.options?.agent_id) ?? qaAgentOf(agents, settings) ?? agents[0] ?? null;

  const state = phase?.state;
  const log = useRunLog({ taskId }, state);

  // The session appears when the agent starts it: go to the run, keeping the way back.
  useEffect(() => {
    const sid = log.sessionId;
    if (!sid || moved.current) return;
    moved.current = true;
    navigate(runHref({ id: sid, platform: log.platform }, from), { replace: true });
  }, [log.sessionId, log.platform, from, navigate]);

  // Ended with no session and nothing to show: back on the step, which has already moved on.
  useEffect(() => {
    if (state === "done" || state === "skipped") onLeave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!map || !phase) return <div className="qa-run-col"><Skeleton lines={4} label="Loading" /></div>;
  const title = PASS_TITLE[pass];

  if (state === "failed") {
    const { action, options } = retry(pass, map);
    // The agent stays on the run: without it the new task would wait for nobody.
    const again = { ...options, ...(agent ? { agent_id: agent.id } : {}) };
    return (
      <div className="qa-run-pending qa-run-rise" data-run-pending="failed">
        <div className="qa-run-waiting">
          <div>
            <h1 className="qa-run-waiting-t">This run stopped</h1>
            <p className="qa-run-waiting-b">{failureText(phase.note)}.</p>
          </div>
          {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
          <Button variant="primary" busy={busy === action} disabled={!auth.can} onClick={() => void act(action, again, auth.human?.id ?? null)} data-run-again>Run again</Button>
        </div>
        {taskId ? <ActivityPanel log={log} auth={auth} /> : null}
      </div>
    );
  }
  if (phase.blocked_reason === NO_AGENT && setup.data) {
    return (
      <div className="qa-run-col">
        <SetupGate cid={cid} auth={auth} setup={setup.data} waitingTask={taskId} onDone={() => void refresh()} />
      </div>
    );
  }
  const task = (snap?.tasks ?? []).find((t) => t.id === taskId);
  const who = task?.assignees?.[0] ?? null;
  const why = phase.blocked_reason ?? null;
  return (
    <RunLogProvider value={log}>
      <div className="qa-run-pending qa-run-rise" data-run-pending={why ? "blocked" : "waiting"}>
        <h1 className="qa-run-waiting-t">{title}</h1>
        <ActivityPanel log={log} auth={auth} fallback={why ?? (who ? `Waiting for ${who} to start` : "Starting")} />
      </div>
    </RunLogProvider>
  );
}
