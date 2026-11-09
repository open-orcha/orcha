/**
 * Quality and Triage steps in Workflows. In a draft, the two dialogs: what the step does, on what,
 * for how long, who takes it and where each outcome goes. On a saved workflow, the live side: each
 * step's status on the graph and rows, and its panel with the running session's device, findings,
 * what triage decided and every round.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, ButtonLink, Chip, Dialog, MenuButton, Section, Segmented } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { useRequestsChanged } from "../../state/qaRequestBus";
import { Filmstrip, FrameLightboxProvider, FrameShapeProvider } from "../qa/Frames";
import { DeviceField } from "../qa/onboarding/device-field";
import { deviceValue, pickerRows, rowForKey, rowForValue } from "../qa/onboarding/device-picker";
import { useLiveDevices } from "../qa/onboarding/use-live-devices";
import { useLoad } from "../qa/parts";
import { listScenarios, listTargets, PLATFORMS, type Platform, type QaFinding } from "../qa/qaApi";
import { platformWord, plural, severityTone, severityWord } from "../qa/qaWords";
import { DEFAULT_QA_SETTINGS, getQaSettings, getRequest, listRequests, MAX_ROUNDS, MIN_ROUNDS, type QaRequest } from "../qa/requests/api";
import { requestHref, runPageHref, sessionHref } from "../qa/requests/links";
import { isOpenRequest, linesTally, qaAgentOf, roundsOf } from "../qa/requests/model";
import { requestFindings } from "../qa/requests/RequestDetail";
import { requestStatusGlyph, requestStatusWord, requestTone, roundWord } from "../qa/requests/words";
import { QaStatus } from "../qa/parts";
import { normalizeDiagnosis } from "../qa/triage/api";
import { DiagnosisList } from "../qa/triage/DiagnosisList";
import { classificationTone, classificationWord, decisionOf, decisionWord } from "../qa/triage/words";
import { DEFAULT_MINUTES, QA_RUN_KINDS, TIMED_KINDS, type QaRunKind } from "../qa/runQa";
import type { WorkflowDetail, WorkflowTask } from "./workflowContract.generated";
import { draftTaskName, type DraftQaStep, type WorkflowDraft } from "./workflowDraft";
import { addQaStep, addTriageStep, DEFAULT_QA_ROUNDS, editQaStep, editTriageStep, inOtherLoop, outcomeTone, outcomeWord, qualityWord, routeRows, routeValue, setRoute, stepsBefore, testedBy, triageableSteps, triageOf, type QaStepInput, type RouteRow, type TriageStepInput } from "./workflowQa";
import { qualityRounds } from "./qualityRounds";
import "../qa/qa.css";

/* ---- what the two dialogs share ------------------------------------------ */

const tagsOf = (s: string) => [...new Set(s.split(",").map((t) => t.trim()).filter(Boolean))];

type Agent = { id: string; alias: string; role?: string | null };

/** Each outcome, in plain words, and where it goes. Set already; a menu changes it. */
export function WorkflowRouteRows({ rows, onPick }: { rows: readonly RouteRow[]; onPick: (outcome: string, value: string) => void }) {
  return (
    <ul className="qa-plain wf-qr" aria-label="Where each outcome goes">
      {rows.map((r) => (
        <li key={r.outcome} data-route={r.outcome}>
          <Chip size="sm" dot={outcomeTone(r.outcome)}>{outcomeWord(r.outcome)}</Chip>
          <span className="wf-muted" aria-hidden="true">{r.value.startsWith("return") ? "↺" : "→"}</span>
          <MenuButton size="sm" variant="ghost" className="wf-qr-menu" menuLabel={`Where “${outcomeWord(r.outcome)}” goes`} value={r.label}
            items={r.choices.map((c) => ({ label: c.label, checked: c.value === r.value, onSelect: () => onPick(r.outcome, c.value) }))} />
        </li>
      ))}
    </ul>
  );
}

/** The outcomes of a saved draft step: their routes, editable on its card. */
export function WorkflowStepRoutes({ draft, taskKey, ownerName, onChange }: { draft: WorkflowDraft; taskKey: string; ownerName?: string; onChange: (next: WorkflowDraft) => void }) {
  const loop = draft.repeatGroups?.find((g) => g.members.includes(taskKey));
  return (
    <div className="wf-field">
      <span>What happens next</span>
      <WorkflowRouteRows rows={routeRows(draft, taskKey, ownerName)} onPick={(outcome, value) => onChange(setRoute(draft, taskKey, outcome, value, loop?.maxRounds))} />
    </div>
  );
}

function PlatformField({ value, settings, onChange }: { value: Platform | null; settings: { default_platform: Platform | null }; onChange: (p: Platform | null) => void }) {
  return (
    <div className="qa-field">
      <span className="qa-label">Platform</span>
      <Segmented size="sm" label="Platform to test on" value={value ?? "default"} onChange={(k) => onChange(k === "default" ? null : k as Platform)}
        items={[{ key: "default", label: settings.default_platform ? `Default (${platformWord(settings.default_platform)})` : "Default" }, ...PLATFORMS.map((p) => ({ key: p, label: platformWord(p) }))]} />
    </div>
  );
}

function FocusField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const id = useId();
  return (
    <div className="qa-field">
      <label className="qa-label" htmlFor={id}>Focus <span className="qa-muted">(optional)</span></label>
      <input id={id} className="qa-input" value={value} maxLength={200} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function MinutesField({ value, bad, optional, onChange }: { value: string; bad: boolean; optional?: boolean; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="qa-field">
      <label className="qa-label" htmlFor={id}>Minutes{optional ? <span className="qa-muted"> (optional)</span> : null}</label>
      <input id={id} className="qa-input qa-num" type="number" inputMode="numeric" min={5} max={240} step={5} value={value} aria-invalid={bad || undefined} onChange={(e) => onChange(e.target.value)} />
      {bad ? <p className="qa-error" role="alert">Give it between 5 and 240 minutes.</p> : null}
    </div>
  );
}

function AssigneeField({ agents, who, qaAgent, menuLabel, onChange }: { agents: readonly Agent[]; who: string; qaAgent: Agent | null; menuLabel: string; onChange: (id: string) => void }) {
  return (
    <div className="qa-field">
      <span className="qa-label">Assignee</span>
      {agents.length ? (
        <div><MenuButton menuLabel={menuLabel} size="sm" value={agents.find((a) => a.id === who)?.alias ?? "Choose later"}
          items={[{ label: "Choose later", checked: !who, onSelect: () => onChange("") }, ...agents.map((a) => ({ label: a.alias, hint: a.id === qaAgent?.id ? "Quality agent" : a.role || undefined, checked: who === a.id, onSelect: () => onChange(a.id) }))]} /></div>
      ) : <span className="qa-hint">This project has no AI agents yet.</span>}
      {!qaAgent ? <span className="qa-hint">No Quality agent is set. Choose one under Quality, Apps.</span> : null}
    </div>
  );
}

function RoundsField({ value, bad, hint, onChange }: { value: string; bad: boolean; hint: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="qa-field">
      <label className="qa-label" htmlFor={id}>Most rounds</label>
      <input id={id} className="qa-input qa-num" type="number" inputMode="numeric" min={MIN_ROUNDS} max={MAX_ROUNDS} value={value} aria-invalid={bad || undefined} onChange={(e) => onChange(e.target.value)} />
      {bad ? <p className="qa-error" role="alert">Give it between {MIN_ROUNDS} and {MAX_ROUNDS} rounds.</p> : null}
      <span className="qa-hint">{hint}</span>
    </div>
  );
}

const roundsOk = (n: number) => Number.isInteger(n) && n >= MIN_ROUNDS && n <= MAX_ROUNDS;
const minutesOk = (n: number) => Number.isFinite(n) && n >= 5 && n <= 240;
const currentRoutes = (draft: WorkflowDraft, key: string | null) =>
  Object.fromEntries((draft.tasks.find((t) => t.key === key)?.outcomes ?? []).map((o) => [o.name, routeValue(o)]));

/* ---- the Quality step ----------------------------------------------------- */

export function WorkflowQaStepDialog({ cid, draft, agents, flexible, editing, ownerName, onSave, onClose }: {
  cid: string; draft: WorkflowDraft; agents: Agent[]; flexible: boolean; ownerName?: string;
  /** The Quality step being changed; null adds a new one. */
  editing: string | null; onSave: (input: QaStepInput) => void; onClose: () => void;
}) {
  const tagsId = useId();
  const step = editing ? draft.tasks.find((t) => t.key === editing) ?? null : null;
  const group = editing ? draft.repeatGroups?.find((g) => g.members.includes(editing)) : undefined;
  const settingsRes = useLoad((s) => getQaSettings(cid, s), [cid]);
  const settings = settingsRes.data ?? DEFAULT_QA_SETTINGS;
  const targets = useLoad((s) => listTargets(cid, s), [cid]);
  const ready = PLATFORMS.filter((p) => (targets.data ?? []).some((t) => t.platform === p && t.app_id));

  const candidates = draft.tasks.filter((t) => t.key !== editing && !t.qa && !(editing && stepsBefore(draft, t.key).has(editing)));
  const [kind, setKind] = useState<QaRunKind>(step?.qa?.kind && step.qa.kind !== "triage" ? step.qa.kind : "explore");
  const [platform, setPlatform] = useState<Platform | null>(step?.qa?.platform ?? null);
  const [device, setDevice] = useState<string | null>(step?.qa?.device ?? null);
  const [picked, setPicked] = useState<string[]>(step?.qa?.scenarioIds ?? []);
  const [tags, setTags] = useState((step?.qa?.tags ?? []).join(", "));
  const [focus, setFocus] = useState(step?.qa?.focus ?? "");
  const [minutes, setMinutes] = useState(String(step?.qa?.minutes ?? DEFAULT_MINUTES));
  const [assignee, setAssignee] = useState<string | null>(step ? step.assignee : null);
  const [buildKey, setBuildKey] = useState<string | null>(step ? testedBy(draft, step.key) : candidates.at(-1)?.key ?? null);
  const [rounds, setRounds] = useState<string | null>(group ? String(group.maxRounds) : null);
  const [routes, setRoutes] = useState<Record<string, string>>(() => currentRoutes(draft, editing));

  const qaAgent = qaAgentOf(agents, settings);
  const who = assignee ?? qaAgent?.id ?? "";
  const roundsText = rounds ?? String(settings.max_rounds || DEFAULT_QA_ROUNDS);
  const roundsNum = Number(roundsText);
  const timed = TIMED_KINDS.includes(kind);
  const mins = Number(minutes);
  const minutesBad = timed && !minutesOk(mins);
  const build = draft.tasks.find((t) => t.key === buildKey) ?? null;
  const taken = !!build && !(editing && triageOf(draft, editing)) && inOtherLoop(draft, build.key, editing);
  const checking = kind === "check";
  const scenarioPlatform = platform ?? settings.default_platform ?? ready[0] ?? "ios";
  const scenarios = useLoad(checking ? (s) => listScenarios(cid, scenarioPlatform, s) : null, [cid, scenarioPlatform, checking]);
  const approved = (scenarios.data ?? []).filter((s) => s.status === "validated");
  const usesDevice = kind !== "draft";
  const live = useLiveDevices(cid, usesDevice);
  const deviceRows = useMemo(() => pickerRows(live.devices), [live.devices]);
  const deviceRow = rowForValue(deviceRows, scenarioPlatform, device);
  // A device belongs to a platform: picking one on Default pins the platform it was picked on.
  const pickDevice = (key: string) => {
    const row = rowForKey(deviceRows, key);
    setDevice(row ? deviceValue(row.device) : null);
    if (row) setPlatform(scenarioPlatform);
  };

  const input = (): QaStepInput => ({
    qa: { kind, platform, device: usesDevice ? device : null, scenarioIds: checking ? picked : [], tags: checking ? tagsOf(tags) : [], focus: focus.trim(), minutes: timed ? mins : null } satisfies DraftQaStep,
    assignee: who, buildKey, maxRounds: roundsOk(roundsNum) ? roundsNum : DEFAULT_QA_ROUNDS, flexible, routes,
  });
  // What saving would do, so what the dialog says is what the step will be.
  const plan = useMemo(() => (editing ? editQaStep(draft, editing, input()) : addQaStep(draft, input())), [draft, editing, buildKey, routes, roundsText, flexible]);
  const rows = flexible ? routeRows(plan.draft, plan.key, ownerName) : [];
  const loops = flexible && !!plan.draft.repeatGroups?.some((g) => g.members.includes(plan.key));
  const roundsBad = loops && !roundsOk(roundsNum);

  const save = () => { if (!minutesBad && !roundsBad) onSave(input()); };

  return (
    <Dialog title={editing ? "Edit Quality step" : "Add Quality step"} size="md" onClose={onClose}
      description="A Quality step is a task for your Quality agent. Its result is reported as this step's outcome, and a person still reviews it."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={minutesBad || roundsBad} onClick={save}>{editing ? "Save Quality step" : "Add Quality step"}</Button>
      </>}>
      <form className="qa-form" data-qa-step-form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="qa-field">
          <span className="qa-label">What</span>
          <Segmented size="sm" label="What Quality does" value={kind} onChange={(k) => setKind(k as QaRunKind)} items={QA_RUN_KINDS.map((k) => ({ key: k.key, label: k.label }))} />
          <span className="qa-hint">{QA_RUN_KINDS.find((k) => k.key === kind)!.hint}</span>
        </div>
        <PlatformField value={platform} settings={settings} onChange={(p) => { setPlatform(p); setPicked([]); setDevice(null); }} />
        {usesDevice ? <DeviceField live={live} platform={scenarioPlatform} pickKey={deviceRow?.key ?? ""} onPick={pickDevice} missing={device && !deviceRow && !live.loading ? device : null} maxHeight={260} /> : null}
        {checking ? (
          <>
            <div className="qa-field" role="group" aria-label="Scenarios to check">
              <span className="qa-label">Scenarios <span className="qa-muted">(every approved one when none is picked)</span></span>
              {approved.length ? (
                <div className="qa-picks">
                  {approved.slice(0, 40).map((s) => (
                    <label key={s.id} className={"qa-pick" + (picked.includes(s.id) ? " is-on" : "")}>
                      <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((p) => e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id))} />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
              ) : <span className="qa-hint">{scenarios.data ? `No approved scenarios on ${platformWord(scenarioPlatform)} yet.` : "Loading the scenarios…"}</span>}
            </div>
            <div className="qa-field">
              <label className="qa-label" htmlFor={tagsId}>Tags <span className="qa-muted">(optional)</span></label>
              <input id={tagsId} className="qa-input" value={tags} maxLength={200} placeholder="checkout, sign-in" onChange={(e) => setTags(e.target.value)} />
            </div>
          </>
        ) : null}
        <FocusField value={focus} onChange={setFocus} placeholder="What to look at first, e.g. the new checkout" />
        {timed ? <MinutesField value={minutes} bad={minutesBad} onChange={setMinutes} /> : null}
        <AssigneeField agents={agents} who={who} qaAgent={qaAgent} menuLabel="Quality step assignee" onChange={setAssignee} />
        <div className="qa-field">
          <span className="qa-label">Tests</span>
          {candidates.length ? (
            <div><MenuButton menuLabel="Step Quality tests" size="sm" value={build ? draftTaskName(build, draft.tasks) : "Nothing yet"}
              items={[{ label: "No earlier step", checked: !buildKey, onSelect: () => { setBuildKey(null); setRoutes({}); } }, ...candidates.map((t) => ({ label: draftTaskName(t, draft.tasks), checked: buildKey === t.key, onSelect: () => { setBuildKey(t.key); setRoutes({}); } }))]} /></div>
          ) : <span className="qa-hint">No other steps yet. Add a build step to send failures back to it.</span>}
        </div>
        {flexible ? (
          <div className="qa-field" role="group" aria-label="What happens next">
            <span className="qa-label">What happens next</span>
            <WorkflowRouteRows rows={rows} onPick={(outcome, value) => setRoutes((r) => ({ ...r, [outcome]: value }))} />
            {taken ? <span className="qa-hint">{draftTaskName(build!, draft.tasks)} is already in a feedback loop, so a fail asks the owner.</span> : null}
            {loops ? <RoundsField value={roundsText} bad={roundsBad} hint="At the limit, the owner decides." onChange={setRounds} /> : null}
          </div>
        ) : <span className="qa-hint">This server runs one route, so the step just lets the next steps start once it is accepted.</span>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/* ---- the Triage step ------------------------------------------------------ */

/** A Triage step: what it diagnoses, who takes it, and where each decision goes. */
export function WorkflowTriageStepDialog({ cid, draft, agents, flexible, editing = null, ownerName, onSave, onClose }: {
  cid: string; draft: WorkflowDraft; agents: Agent[]; flexible: boolean; ownerName?: string;
  /** The Triage step being changed; null adds a new one. */
  editing?: string | null; onSave: (input: TriageStepInput) => void; onClose: () => void;
}) {
  const settingsRes = useLoad((s) => getQaSettings(cid, s), [cid]);
  const settings = settingsRes.data ?? DEFAULT_QA_SETTINGS;
  const step = editing ? draft.tasks.find((t) => t.key === editing) ?? null : null;
  const steps = triageableSteps(draft);
  const [qaKey, setQaKey] = useState(steps.find((t) => step?.dependsOn.includes(t.key))?.key ?? steps.at(-1)?.key ?? "");
  const qa = steps.find((t) => t.key === qaKey) ?? null;
  const [assignee, setAssignee] = useState<string | null>(step ? step.assignee : null);
  const [platform, setPlatform] = useState<Platform | null>(step?.qa?.platform ?? qa?.qa?.platform ?? null);
  const [focus, setFocus] = useState(step?.qa?.focus ?? "");
  const [minutes, setMinutes] = useState(step?.qa?.minutes ? String(step.qa.minutes) : "");
  const [routes, setRoutes] = useState<Record<string, string>>(() => currentRoutes(draft, editing));
  const existing = draft.repeatGroups?.find((g) => (editing ? g.review === editing : g.review === qaKey));
  const [rounds, setRounds] = useState<string | null>(existing ? String(existing.maxRounds) : null);
  const qaAgent = qaAgentOf(agents, settings);
  const who = assignee ?? qaAgent?.id ?? "";
  const roundsText = rounds ?? String(settings.max_rounds || DEFAULT_QA_ROUNDS);
  const roundsNum = Number(roundsText);
  const mins = Number(minutes);
  const minutesBad = !!minutes.trim() && !minutesOk(mins);
  const input = (): TriageStepInput => ({ qaKey, assignee: who, maxRounds: roundsOk(roundsNum) ? roundsNum : DEFAULT_QA_ROUNDS, flexible, platform, focus, minutes: minutes.trim() ? mins : null, routes });
  const plan = useMemo(() => (!qa ? null : editing ? editTriageStep(draft, editing, input()) : addTriageStep(draft, input())), [draft, editing, qaKey, routes, roundsText, flexible]);
  const rows = flexible && plan ? routeRows(plan.draft, plan.key, ownerName) : [];
  const loops = flexible && !!plan?.draft.repeatGroups?.some((g) => g.review === plan.key);
  const roundsBad = loops && !roundsOk(roundsNum);
  const save = () => { if (qa && !roundsBad && !minutesBad) onSave(input()); };
  return (
    <Dialog title={editing ? "Edit triage step" : "Add triage step"} size="md" onClose={onClose}
      description="A failed Quality step goes to triage first, so nobody burns a round on a flaky test. It re-runs each finding at least three times and finds the root cause."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!qa || roundsBad || minutesBad} onClick={save}>{editing ? "Save triage step" : "Add triage step"}</Button>
      </>}>
      <form className="qa-form" data-triage-step-form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="qa-field">
          <span className="qa-label">Diagnoses</span>
          {editing ? <span>{qa ? draftTaskName(qa, draft.tasks) : "No Quality step"}</span> : (
            <div><MenuButton menuLabel="Quality step to diagnose" size="sm" value={qa ? draftTaskName(qa, draft.tasks) : "Choose a Quality step"}
              items={steps.map((t) => ({ label: draftTaskName(t, draft.tasks), checked: t.key === qaKey, onSelect: () => { setQaKey(t.key); setRoutes({}); } }))} /></div>
          )}
          <span className="qa-hint">It takes the findings this step reports. Scenarios and tags come from there too.</span>
        </div>
        <PlatformField value={platform} settings={settings} onChange={setPlatform} />
        <FocusField value={focus} onChange={setFocus} placeholder="What to weigh first, e.g. anything that touches payment" />
        <MinutesField value={minutes} bad={minutesBad} optional onChange={setMinutes} />
        <AssigneeField agents={agents} who={who} qaAgent={qaAgent} menuLabel="Triage step assignee" onChange={setAssignee} />
        {flexible ? (
          <div className="qa-field" role="group" aria-label="What happens next">
            <span className="qa-label">What happens next</span>
            <WorkflowRouteRows rows={rows} onPick={(outcome, value) => setRoutes((r) => ({ ...r, [outcome]: value }))} />
            {loops ? <RoundsField value={roundsText} bad={roundsBad} hint="It covers the whole loop: build, Quality and Triage. At the limit, the owner decides." onChange={setRounds} /> : null}
          </div>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/* ---- the live side -------------------------------------------------------- */

const LIVE_MS = 6_000;

/** The workflow's QA requests by step, read again while one is open. */
export function useWorkflowQa(cid: string | null, detail: WorkflowDetail | null) {
  const [tick, setTick] = useState(0);
  const workflowId = detail?.id ?? null;
  const changed = useRequestsChanged();
  const res = useLoad(cid && workflowId ? (s) => listRequests(cid, { source_workflow_id: workflowId }, s) : null, [cid, workflowId], tick + changed);
  const rows = res.data;
  const open = (rows ?? []).some(isOpenRequest);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), LIVE_MS);
    return () => clearInterval(t);
  }, [open]);
  const byTask = useMemo(() => {
    const out: Record<string, QaRequest[]> = {};
    for (const r of rows ?? []) if (r.source_task_id) (out[r.source_task_id] ??= []).push(r);
    return out;
  }, [rows]);
  return {
    byTask,
    /** Moves when a request changes. */
    changed,
    /** The workflow's Quality rounds, first to last. */
    rounds: detail ? qualityRounds(detail, rows ?? []) : [],
    /** The step's Quality panel: a Quality or Triage step, or a step that has been to Quality. */
    of: (task: WorkflowTask) => (isQaTask(task) || byTask[task.id]?.length ? { requests: byTask[task.id] ?? [], nonce: tick + changed } : null),
  };
}

const isQaTask = (task: WorkflowTask) => !!task.qa;

export interface QaMark { word: string; tone: "ok" | "danger" | "warn" | "neutral"; kind: "quality" | "triage" }

/** A step's mark on the graph and rows: "Quality · Running · Round 2". A mark from an earlier round says so. */
export function qaMark(task: WorkflowTask, requests: readonly QaRequest[] | undefined, currentRound?: number): QaMark | undefined {
  const rounds = roundsOf(requests ?? []);
  const latest = rounds.at(-1);
  if (!latest) return isQaTask(task) ? (task.qa?.kind === "triage" ? { word: "Triage step", tone: "neutral", kind: "triage" } : { word: "Quality step", tone: "neutral", kind: "quality" }) : undefined;
  const past = latest.round < Math.max(currentRound ?? 0, task.round ?? 0);
  if (latest.kind === "triage") {
    const mark = latest.status === "requested" && task.status === "in_progress" ? { word: "Triage · Getting ready", tone: "neutral" as const, kind: "triage" as const } : triageMark(latest);
    return past ? { ...mark, word: `${mark.word} · Round ${latest.round}`, tone: "neutral" } : mark;
  }
  const status = latest.status !== "requested" ? requestStatusWord(latest.status) : task.awaiting_owner_decision ? "Stopped" : task.status === "in_progress" ? "Getting ready" : requestStatusWord(latest.status);
  return { word: ["Quality", status, latest.round > 1 || past ? `Round ${latest.round}` : null].filter(Boolean).join(" · "), tone: past ? "neutral" : requestTone(latest.status), kind: "quality" };
}

/** "Triage · 1 of 3 confirmed", "Triage · Needs a person"; its status until it decides. */
function triageMark(r: QaRequest): QaMark {
  const decision = decisionOf(r.result, r.status);
  const rows = r.result?.diagnoses ?? [];
  if (decision === "fix") return { word: `Triage · ${r.result!.confirmed_ids.length} of ${rows.length} confirmed`, tone: "danger", kind: "triage" };
  if (decision === "clear") return { word: "Triage · Clear", tone: "ok", kind: "triage" };
  if (decision === "needs_person") return { word: "Triage · Needs a person", tone: "warn", kind: "triage" };
  return { word: `Triage · ${requestStatusWord(r.status)}`, tone: requestTone(r.status), kind: "triage" };
}

/** A finding with what triage made of it. */
function FindingLine({ f, session, platform }: { f: QaFinding; session: string | null; platform: string | null }) {
  const d = normalizeDiagnosis(f.triage);
  return (
    <li className="wf-qa-finding">
      <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity)}</Chip>
      <Link className="qa-taskqa-t" to={sessionHref(f.session_id ?? session ?? "", platform)}>{f.title}</Link>
      {d ? <Chip size="sm" dot={classificationTone(d.classification)}>{classificationWord(d.classification)}</Chip> : null}
      {d?.rate ? <span className="qa-diag-rate">{d.rate}</span> : null}
    </li>
  );
}

/** One earlier round, opened to what it found and what triage decided. */
function RoundLine({ r }: { r: QaRequest }) {
  const rows = r.result?.diagnoses ?? [];
  const findings = r.result?.findings ?? [];
  return (
    <li>
      <details className="wf-qa-rd">
        <summary>
          <QaStatus glyph={requestStatusGlyph(r.status)} word={requestStatusWord(r.status)} size={12} />
          <span>{roundWord(r.round)}</span>
          <span className="wf-muted">{[requestStatusWord(r.status), linesTally(r), r.result?.finding_ids.length ? plural(r.result.finding_ids.length, "finding") : null, relTime(r.created_at)].filter(Boolean).join(" · ")}</span>
        </summary>
        <div className="wf-qa-rd-b">
          {r.result?.summary ? <p className="wf-p">{qualityWord(r.result.summary)}</p> : null}
          {rows.length ? <DiagnosisList rows={rows} platform={r.platform} session={r.session_id} /> : null}
          {!rows.length && findings.length ? <ul className="qa-plain">{findings.map((f) => <FindingLine key={f.id} f={f} session={r.session_id} platform={r.platform} />)}</ul> : null}
          <Link className="wf-qa-link" to={requestHref(r)}>Open the request</Link>
        </div>
      </details>
    </li>
  );
}

/** The step's Quality: its live status, the device while it runs, the findings and every round so far. */
export function WorkflowQaStepPanel({ requests, nonce, triage = false }: { requests: readonly QaRequest[]; nonce: number; triage?: boolean }) {
  const rounds = roundsOf(requests);
  const latest = rounds.at(-1) ?? null;
  const res = useLoad(latest ? (s) => getRequest(latest.id, s) : null, [latest?.id], nonce);
  const current = res.data ?? latest;
  const findings = requestFindings(current);
  const session = current?.session_id ?? null;
  const decided = decisionWord(decisionOf(current?.result, current?.status ?? ""));
  return (
    <Section title={triage ? "Triage" : "Quality"} actions={latest ? <Link className="wf-qa-link" to={requestHref(latest)}>Open the request</Link> : undefined}>
      {!current ? <p className="wf-muted wf-p">{triage ? "This step diagnoses what Quality found. It starts when a Quality round fails." : "This step asks Quality for its result. The request starts when the step does."}</p> : (
        <FrameLightboxProvider>
          <FrameShapeProvider shape={current.platform === "web" ? "wide" : "phone"}>
            <div className="wf-qa" data-qa-step={current.id}>
              <div className="wf-qa-status">
                <QaStatus glyph={requestStatusGlyph(current.status)} word={requestStatusWord(current.status)} show size={13} />
                <span className="wf-muted">{[roundWord(current.round, current.max_rounds), linesTally(current)].filter(Boolean).join(" · ")}</span>
              </div>
              {current.result?.summary ? <p className="wf-p">{qualityWord(current.result.summary)}</p> : null}
              {session ? (
                <div className="wf-qa-actions">
                  {current.status === "running" ? <ButtonLink size="sm" icon="live" to={runPageHref(session, current.platform)}>Watch the device</ButtonLink> : <ButtonLink size="sm" variant="ghost" to={sessionHref(session, current.platform)}>Open the session</ButtonLink>}
                </div>
              ) : null}
              {current.result?.diagnoses.length ? (
                <div className="wf-qa-group" data-triage-decided>
                  <div className="wf-qa-k">What triage decided{decided ? `: ${decided.toLowerCase()}` : ""}</div>
                  <DiagnosisList rows={current.result.diagnoses} platform={current.platform} session={current.session_id} />
                </div>
              ) : null}
              {findings.length ? (
                <div className="wf-qa-group">
                  <div className="wf-qa-k">{plural(findings.length, "finding")}</div>
                  <ul className="qa-plain" aria-label="Quality findings">
                    {findings.map((f) => <FindingLine key={f.id} f={f} session={session} platform={current.platform} />)}
                  </ul>
                  <Filmstrip label="Finding screenshots" frames={findings.flatMap((f) => (f.frame_ids ?? []).slice(0, 1).map((id) => ({ id, caption: f.title })))} />
                </div>
              ) : null}
              {rounds.length > 1 ? (
                <div className="wf-qa-group">
                  <div className="wf-qa-k">Rounds</div>
                  <ol className="qa-plain" aria-label="Quality rounds">{rounds.map((r) => <RoundLine key={r.id} r={r} />)}</ol>
                </div>
              ) : null}
            </div>
          </FrameShapeProvider>
        </FrameLightboxProvider>
      )}
    </Section>
  );
}
