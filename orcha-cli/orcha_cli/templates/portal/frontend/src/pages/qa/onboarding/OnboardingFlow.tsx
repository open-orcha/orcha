/**
 * The QA onboarding, "Let us map your app": Connect → We found → Map → Coverage → Bring it in →
 * First run. Connect reads the project folder; We found is one sheet of what the repository told
 * Embodent, each part editable in place, and saving it writes the project's QA targets; from
 * there the server's snapshot drives the steps. Nobody types a bundle id unless detection failed
 * (`onManual` opens the app settings).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { MenuButton } from "../../../components/primitives";
import { PortRoot } from "../map/kit";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { BringInStep } from "./bring-in-step";
import type { Plan } from "./choreo";
import { settled, type BringInOptions, type FirstRunOptions, type MapAction, type MapPhase } from "./contract";
import { CoverageStep } from "./coverage-step";
import { FirstRunMap, FirstTestCard } from "./first-run-map";
import { canContinue, FLOW_COPY, FLOW_KEYS, FLOW_STEPS, flowReducer, initialFlow, phaseAnnouncement, stepIndex, type FlowStep } from "./flow";
import { FlowRail } from "./flow-rail";
import { liveBackendLine, targetBackend } from "./backends";
import { deviceLabel, deviceSentence, FoundSheet, type FoundPreview, type FoundSection } from "./found-sheet";
import { FirstRunStep } from "./first-run-step";
import { MapStep } from "./map-step";
import { RepositoryStep } from "./repository-step";
import { TeachingState } from "./scenes";
import { fallbackFirstTest } from "./coverage";
import { useLiveDevices } from "./use-live-devices";
import { useOnboardingMap } from "./use-onboarding-map";
import { runPlacement, type SummaryPlan } from "./runs-on-summary";
import { applySet, clearDraft, confirmOptions, defaultFirstRunTarget, enabledTargets, initialState, readDraft, stateFromFound, toRunDevice, validateFirstRun, validateTargets, writeDraft, type SetField, type WizardState } from "./state";
import { createQaTask, qaTaskBody, type QaRunKind } from "../runQa";
import { useLoad } from "../parts";
import { getQaSettings } from "../requests/api";
import { qaAgentOf } from "../requests/model";
import { onboardingFrom, parsePass, passHref, runHref, type RunPass } from "../run/runFlow";
import { queueSession } from "../sessions/api";
import { getQaSetup, NO_AGENT, setupMissing } from "../setup/setup";
import { SetupGate } from "../setup/SetupGate";
import { Button, cn } from "./ui";
import type { TargetKind } from "./types";

/** The step a project's row reopens on. `broughtIn`: Bring it in has been started; until then
 * Coverage comes first, so nobody who stepped away while the map finished skips it. */
export function stepOfPhase(phase: MapPhase, found: boolean, broughtIn = true): FlowStep {
  if (phase === "found") return found ? "found" : "connect";
  if (phase === "code_map" || phase === "tests" || phase === "live") return "map";
  if (phase === "coverage") return "coverage";
  if (phase === "bring_in") return broughtIn ? "bring_in" : "coverage";
  return "first_run";
}

export interface OnboardingFlowProps {
  cid: string;
  auth: QaAuthority;
  /** Detection failed or was refused: the app settings. */
  onManual: () => void;
  /** Leave the flow for Quality's Exploration tab. */
  onOpenMap: () => void;
  /** "More ways to start": the Run page. */
  onRunQa: (kind: QaRunKind) => void;
  /** A first run was queued: leave for its session. */
  onOpenSessions?: () => void;
}

export function OnboardingFlow(props: OnboardingFlowProps) {
  return (
    <PortRoot refresh={noRefresh} className="flex min-h-0 flex-1 flex-col">
      <Flow {...props} />
    </PortRoot>
  );
}

const noRefresh = () => undefined;

function Flow({ cid, auth, onManual, onOpenMap, onRunQa, onOpenSessions }: OnboardingFlowProps) {
  const resumedRef = useRef(false);
  const { snap } = useSnapshot();
  const mapLoad = useOnboardingMap(cid);
  const { map, act, load } = mapLoad;
  const foundMissing = load.kind === "missing";
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef(location.search);
  searchRef.current = location.search;
  const [flow, dispatch] = useReducer(flowReducer, "connect" as FlowStep, initialFlow);
  const step = flow.step;
  const afterSettled = useRef(false);
  // The step lives in the address: a reload, or leaving and coming back, reopens exactly here.
  useEffect(() => {
    if (step === "connect" || !resumedRef.current) return;
    // Both address writes can land in one tick, and the later one wins: a settled `after` goes here too.
    setParams((cur) => { const n = new URLSearchParams(cur); n.set("step", step); if (afterSettled.current) n.delete("after"); return n; }, { replace: true });
  }, [step, setParams]);
  const [setupTick, setSetupTick] = useState(0);
  const setup = useLoad((s) => getQaSetup(cid, s), [cid, setupTick]).data;
  const [foundOpen, setFoundOpen] = useState<FoundSection | null>(null);
  const [foundErrors, setFoundErrors] = useState<Partial<Record<FoundSection, string>>>({});
  // A reload keeps what was entered (this tab only, #454).
  const [restored] = useState(() => readDraft(cid));
  const [showRestored, setShowRestored] = useState(Boolean(restored));
  const [state, setState] = useState<WizardState>(() => restored ?? initialState());
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const live = useLiveDevices(cid, step === "found");
  const devices = live.devices;
  const planRef = useRef<Plan | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstStepRender = useRef(true);
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const [agentPick, setAgentPick] = useState<string | null>(null);
  const qaSettings = useLoad((s) => getQaSettings(cid, s), [cid]).data;
  // The picked agent, the one saved on the row, the project's QA agent, else whoever is there: a run
  // never leaves here with nobody on it while the project has an agent.
  const agent = agents.find((a) => a.id === (agentPick ?? map?.options?.agent_id)) ?? qaAgentOf(agents, qaSettings) ?? agents[0] ?? null;

  // Each step opens at its title, which takes the focus.
  useEffect(() => {
    if (firstStepRender.current) {
      firstStepRender.current = false;
      return;
    }
    rootRef.current?.scrollIntoView?.({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const onAct = useCallback(
    (action: MapAction, options?: object) => {
      setError(null);
      if (!auth.can) {
        setError(auth.reason || "Only a person can do this.");
        return;
      }
      void act(action, { ...(options ?? {}), ...(agent ? { agent_id: agent.id } : {}) }, auth.human?.id ?? null).then((err) => {
        if (err) return setError(err);
        // An agent run started: straight to its live page, whose Back returns to this exact step.
        // Its session only exists once the agent starts it, so nothing here waits for one.
        const pass: RunPass | null = action === "run_live" ? "live" : action === "first_run" ? "first_run" : action === "bring_in" && (options as BringInOptions | undefined)?.draft ? "bring_in" : null;
        if (pass) navigate(passHref(pass, onboardingFrom(searchRef.current, pass)));
      });
    },
    [act, agent?.id, auth, navigate],
  );

  // Connect: the folder is read as soon as the step opens (a person's first look starts it).
  const started = useRef(false);
  const foundState = map?.phases.found.state ?? "pending";
  useEffect(() => {
    if (started.current || !auth.can || load.kind === "loading" || load.kind === "missing") return;
    if (foundState !== "pending" || map?.unavailable) return;
    started.current = true;
    onAct("start");
  }, [auth.can, foundState, load.kind, map?.unavailable, onAct]);

  // Reopened: back on the step the address names, else the one the row says, once.
  const resumed = resumedRef;
  useEffect(() => {
    if (resumed.current || !map) return;
    resumed.current = true;
    // `code_map` still pending is the row waiting for "Save and map": back on the sheet, never the map.
    const at = map.phases.code_map.state === "pending" ? stepOfPhase("found", foundState === "done") : stepOfPhase(map.phase, foundState === "done", map.phases.bring_in.state !== "pending");
    const asked = params.get("step") as FlowStep | null;
    // The address may name anything reached: Bring it in before anything started there, First run after Skip.
    const furthest = map.phases.code_map.state === "pending" ? at : map.phase === "bring_in" ? "first_run" : stepOfPhase(map.phase, foundState === "done");
    const named = asked && FLOW_STEPS.includes(asked) && FLOW_STEPS.indexOf(asked) <= FLOW_STEPS.indexOf(furthest) ? asked : null;
    if ((named ?? at) !== "connect") dispatch({ type: "jump", step: named ?? at });
  }, [map, foundState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from a run that ended: the step moves on, as it does for someone who stayed here to watch.
  const after = parsePass(params.get("after"));
  const afterState = after ? map?.phases[after].state : null;
  useEffect(() => {
    if (!after || !map || !afterState || afterState === "running") return;
    afterSettled.current = true;
    setParams((cur) => { const n = new URLSearchParams(cur); n.delete("after"); return n; }, { replace: true });
    if (afterState !== "done" && afterState !== "skipped") return;
    const at = stepOfPhase(map.phase, true, map.phases.bring_in.state !== "pending");
    if (stepIndex(at) > stepIndex(step)) dispatch({ type: "jump", step: at });
  }, [after, afterState]); // eslint-disable-line react-hooks/exhaustive-deps

  // No agent, or the tools off: one clear state, and a task already stuck waits for what it picks.
  const missing = setupMissing(setup ?? null);
  const stuckTask = map ? Object.values(map.phases).find((p) => p.blocked_reason === NO_AGENT)?.task_id ?? null : null;
  const showSetup = !!setup && (step === "found" || step === "map") && (!!missing || !!stuckTask);

  // On the map with nothing asked of it (a confirm that failed, or a row restarted elsewhere): back to
  // the sheet, where the error shows and "Save and map" is one click away.
  useEffect(() => {
    if (step === "map" && map && !mapLoad.busy && map.phases.code_map.state === "pending" && foundState === "done") {
      dispatch({ type: "jump", step: "found" });
    }
  }, [step, map, mapLoad.busy, foundState]);

  // What the scan found lands in the sheet's state; a person's edits stay.
  const found = map && (map.phases.found.state === "done" || map.found.platforms.length > 0) ? map.found : null;
  const foundKey = found ? JSON.stringify(found.platforms) : "";
  useEffect(() => {
    if (found) setState((s) => stateFromFound(s, found));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foundKey]);

  const set: SetField = (key, value) => {
    // What the sheet reads for itself is not an edit.
    setState((s) => ({ ...s, [key]: applySet(s[key], value), touched: s.touched || key !== "backends" }));
    setError(null);
  };

  useEffect(() => {
    if (state.touched) writeDraft(cid, state);
  }, [cid, state]);

  /** "Start over": forget the edits and go back to what the scan found. */
  function startOver() {
    clearDraft(cid);
    setShowRestored(false);
    setFoundOpen(null);
    setFoundErrors({});
    setError(null);
    setState(found ? stateFromFound(initialState(), found) : initialState());
  }

  const enabled = useMemo(() => enabledTargets(state), [state]);
  const firstRunWizardTarget = enabled.find((t) => t.key === state.firstRunTargetKey) ?? defaultFirstRunTarget(state.targets);

  /** We found → Map: check what the sheet holds (opening the part to fix), save it and map. */
  function saveAndMap() {
    const targetErr = validateTargets(state);
    if (targetErr) {
      setFoundOpen("platforms");
      setFoundErrors({ platforms: targetErr });
      return;
    }
    setFoundErrors({});
    const def = defaultFirstRunTarget(state.targets);
    if (def && !enabled.some((t) => t.key === state.firstRunTargetKey)) set("firstRunTargetKey", def.key);
    onAct("confirm", confirmOptions(state, devices));
    dispatch({ type: "next" });
  }

  function openMap() {
    setLeaving(true);
    clearDraft(cid);
    onAct("skip");
    onOpenMap();
  }

  const kindOf = (platform?: string): TargetKind =>
    (["ios", "android", "web"] as const).find((k) => k === platform) ?? firstRunWizardTarget?.kind ?? enabled[0]?.kind ?? "web";
  /** The device a platform runs on, as the Device editor says it ("Any booted simulator"). */
  const deviceName = (platform?: string) => {
    const kind = kindOf(platform);
    return deviceLabel(devices, state.deviceKeys[kind], kind);
  };
  const deviceFor = (kind: TargetKind) => toRunDevice(kind, state.deviceKeys[kind], devices);
  // "Map on Android": a live pass on another platform takes the device picked for that platform.
  const onMapAct = (action: MapAction, options?: object) => {
    if (action === "run_live" && missing) return; // the setup state above answers this
    const o = (options ?? {}) as { platform?: TargetKind; device?: unknown };
    const dev = action === "run_live" && o.platform && !o.device ? deviceFor(o.platform) : null;
    onAct(action, dev ? { ...o, device: dev } : options);
  };
  // The live pass's platform, its device in a sentence, and what its build talks to (#453).
  const livePlatform = map?.live_run?.platform ?? map?.found.live_platform?.kind ?? (state.livePlatform || map?.found.platforms[0]?.kind || undefined);
  const liveKind = kindOf(livePlatform);
  const liveTarget = enabled.find((t) => t.kind === liveKind);
  const liveBackend = liveBackendLine(state.backends, liveKind, liveTarget ? targetBackend(state.backends, liveTarget) : null);
  const copy = FLOW_COPY[step];
  const afterFound = step === "map" || step === "coverage" || step === "bring_in" || step === "first_run";
  const gate = canContinue(step, map);
  const pick = map ? fallbackFirstTest(map) : null;
  const bringDone = map ? settled(map.phases.bring_in) : false;
  const phaseLine = afterFound && map ? phaseAnnouncement(map).text : "";
  const cannotRead = map?.unavailable ?? (foundState === "failed" ? map?.phases.found.note ?? map?.error ?? "The project folder could not be read." : null);
  const reading = !cannotRead && (foundState === "running" || (foundState === "pending" && auth.can && load.kind !== "missing" && !error));
  const preview: FoundPreview = found ? { kind: "ready", found } : reading ? { kind: "loading" } : { kind: "missing" };

  /** A first run with the device for its platform. */
  const firstRun = (options: FirstRunOptions = {}) => {
    const kind = options.platform ?? firstRunWizardTarget?.kind;
    const runOn = kind ? deviceFor(kind) : null;
    onAct("first_run", { ...options, ...(runOn ? { device: runOn } : {}) });
  };
  const runFirst = (options: FirstRunOptions) => {
    firstRun(options);
    dispatch({ type: "jump", step: "first_run" });
  };

  // What "Queue run" queues: the chosen platform, or every enabled one ("All platforms").
  const exploring = state.mode === "exploratory";
  const firstRunTargets = enabled.length > 1 && state.firstRunScope === "all" ? enabled : firstRunWizardTarget ? [firstRunWizardTarget] : [];
  const scenarioFile = state.scenarioFile.trim();
  const firstRunPlans: SummaryPlan[] = firstRunTargets.map((t) => ({
    placement: runPlacement({ kind: t.kind, device: deviceFor(t.kind) }),
    minutes: exploring ? Number(state.minutes) || null : null,
    file: exploring ? null : scenarioFile || null,
  }));

  /** The older first-run choices: one normal task per platform, then on to its session. */
  async function queueRun() {
    const err = validateFirstRun(state);
    if (err) return setError(err);
    if (!auth.can) return setError(auth.reason || "Only a person can start QA work.");
    if (!agent) return setError("Pick the agent who runs it on the We found step.");
    setSubmitting(true);
    setError(null);
    try {
      const kind = exploring ? "explore" : "check";
      const minutes = exploring ? Number(state.minutes) : null;
      let first: { id: string; platform: string } | null = null;
      for (const t of firstRunTargets) {
        const { task_id } = await createQaTask(cid, qaTaskBody({
          kind,
          platform: t.kind,
          minutes,
          focus: exploring ? state.focus : scenarioFile ? `The scenarios in ${scenarioFile}` : null,
          agentAlias: agent.alias,
          humanId: auth.human?.id ?? null,
        }));
        const queued = await queueSession(cid, { kind, platform: t.kind, task_id: String(task_id), goal: exploring ? state.focus.trim() || null : null, budget_minutes: minutes, agent_id: agent.id, actor_agent_id: auth.human?.id ?? null }).catch(() => null);
        first ??= queued;
      }
      clearDraft(cid);
      onAct("skip");
      if (first) navigate(runHref(first, "?view=sessions"));
      else (onOpenSessions ?? onOpenMap)();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  // The older first-run choices, kept under "More ways to start" on the First run step.
  const classicFirstRun = (
    <div className="flex flex-col gap-3" data-onboarding-more>
      <FirstRunStep state={{ ...state, firstRunTargetKey: firstRunWizardTarget?.key ?? "" }} set={set} plans={firstRunPlans} onMore={() => onRunQa("explore")} disabled={!auth.can} />
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void queueRun()} loading={submitting} disabled={!auth.can} data-onboarding-submit>
          {exploring ? "Start exploring" : "Queue run"}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-4.5 py-6 transition-[max-width] duration-300 ease-out motion-reduce:transition-none",
        afterFound ? "min-h-[640px] max-w-[1320px] flex-1" : step === "found" ? "max-w-3xl" : "max-w-2xl",
      )}
      data-onboarding
      data-onboarding-wide={afterFound ? "" : undefined}
      data-onboarding-flow={step}
    >
      <FlowRail current={step} reached={flow.reached} locked={Boolean(map && map.phases.code_map.state !== "pending")} onGo={(s) => dispatch({ type: "go", step: s })} />
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-onboarding-announce>{flow.announcement}</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-onboarding-phase-line>{phaseLine}</p>
      <header>
        <h1 ref={headingRef} tabIndex={-1} className="text-[22px] font-semibold leading-7 tracking-[-0.01em] text-fg outline-none">
          {copy.title}
        </h1>
        <p className="mt-1 text-sm text-muted">{copy.lead}</p>
      </header>

      <div className={cn(afterFound ? "flex min-h-0 flex-1 flex-col" : "rounded-lg border border-border bg-panel p-5")} data-onboarding-step={FLOW_KEYS[step]}>
        {showRestored && (step === "connect" || step === "found") ? (
          <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted" role="status" data-onboarding-restored>
            Picked up where you left off before the page reloaded.
            <button type="button" className="font-medium text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={startOver} data-onboarding-start-over>
              Start over
            </button>
          </p>
        ) : null}
        {!auth.can ? <p className="mb-3 text-xs text-muted" data-onboarding-gate-human>{auth.reason || "Only a person can run the onboarding."}</p> : null}
        {step === "connect" ? <RepositoryStep state={state} found={found} reading={reading} error={error} /> : null}
        {showSetup && setup ? <SetupGate cid={cid} auth={auth} setup={setup} waitingTask={stuckTask} onDone={(id) => { if (id) setAgentPick(id); setSetupTick((n) => n + 1); void mapLoad.refresh(); }} /> : null}
        {step === "found" ? (
          <FoundSheet state={state} set={set} preview={preview} open={foundOpen} onOpen={setFoundOpen} errors={foundErrors}
            devices={devices} devicesLoading={live.loading} devicesAvailable={live.available}
            agentField={
              agents.length ? (
                <MenuButton menuLabel="Agent" size="sm" value={agent?.alias ?? "Pick an agent"}
                  items={agents.map((a) => ({ label: a.alias, hint: a.role || undefined, checked: agent?.id === a.id, onSelect: () => setAgentPick(a.id) }))} />
              ) : <span className="text-muted">No agent yet</span>
            } />
        ) : null}
        {step === "map" ? (
          <MapStep
            load={load}
            planRef={planRef}
            busy={mapLoad.busy}
            device={deviceSentence(deviceName(livePlatform))}
            backendLine={liveBackend}
            building={null}
            livePass={state.livePass}
            onAct={onMapAct}
            onRetry={() => void mapLoad.refresh()}
            onClassic={onManual}
          />
        ) : null}
        {step === "coverage" && map ? <CoverageStep map={map} planRef={planRef} /> : null}
        {step === "bring_in" && map ? (
          <div className="flex flex-col gap-4">
            <BringInStep map={map} slug={cid} planRef={planRef} busy={mapLoad.busy} onAct={(a: MapAction, o: BringInOptions) => onAct(a, o)} />
            {bringDone && pick ? (
              <FirstTestCard map={map} pick={pick} device={deviceName} busy={mapLoad.busy} onRun={runFirst} onPick={() => dispatch({ type: "jump", step: "first_run" })} />
            ) : null}
          </div>
        ) : null}
        {step === "first_run" && map ? (
          <FirstRunMap
            map={map}
            planRef={planRef}
            busy={mapLoad.busy}
            device={deviceName}
            onAct={(a, o) => (a === "first_run" ? firstRun(o) : onAct(a, o))}
            onOpenMap={openMap}
            leaving={leaving}
            more={classicFirstRun}
          />
        ) : null}
        {(step === "coverage" || step === "bring_in" || step === "first_run") && !map && load.kind === "loading" ? <TeachingState scene="map" title="Opening your map" live /> : null}

        {error ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-danger" data-onboarding-error>
            <span className="min-w-0 flex-1">{error}</span>
            {step === "connect" || step === "found" ? <Button size="sm" onClick={onManual} data-onboarding-manual>Set the app by hand</Button> : null}
          </div>
        ) : null}
        {step === "connect" && (foundMissing || cannotRead) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted" data-onboarding-missing>
            <span className="min-w-0 flex-1">{cannotRead ?? "This portal cannot read the project folder."}</span>
            <Button size="sm" onClick={onManual} data-onboarding-manual>Set the app by hand</Button>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          {/* Never a dead end: where the steps stop, Back leaves them, and Exploration returns here. */}
          <Button onClick={() => { if (step === "connect") onManual(); else if (map && map.phases.code_map.state !== "pending" && step === "map") onOpenMap(); else dispatch({ type: "back" }); }} data-onboarding-back>
            Back
          </Button>
          <div className="flex items-center gap-3">
            {!gate.ok && gate.why ? <span className="text-xs text-muted" data-onboarding-gate>{gate.why}</span> : null}
            {step === "connect" ? (
              <Button variant="primary" onClick={() => dispatch({ type: "next" })} disabled={!found} data-onboarding-next>
                Continue
              </Button>
            ) : step === "found" ? (
              <Button variant="primary" onClick={saveAndMap} loading={mapLoad.busy === "confirm"} disabled={!auth.can || !!missing} data-onboarding-next>
                Save and map
              </Button>
            ) : step === "map" ? (
              <Button variant="primary" onClick={() => dispatch({ type: "next" })} disabled={!gate.ok} data-onboarding-next>
                See coverage
              </Button>
            ) : step === "coverage" ? (
              <Button variant="primary" onClick={() => dispatch({ type: "next" })} data-onboarding-next>
                Bring it in
              </Button>
            ) : step === "bring_in" ? (
              <Button variant={bringDone && pick ? "default" : "primary"} onClick={() => dispatch({ type: "next" })} disabled={!gate.ok} data-onboarding-next>
                {bringDone ? "Continue" : "Skip for now"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
