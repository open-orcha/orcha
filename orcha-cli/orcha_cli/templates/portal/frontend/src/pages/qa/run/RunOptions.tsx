/**
 * Step two of a run: only what this kind needs, every default already chosen. Start creates the task
 * and the session that waits for it, then lands on the live run. A person's click is the approval.
 */
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, MenuButton, Tabs } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { ConditionsField } from "../conditions/ConditionsField";
import { cleanConditions, conditionWords, parseConditions, unavailableWords, type Conditions } from "../conditions/conditions";
import { DeviceField, usePickedRow } from "../onboarding/device-field";
import { PlatformIcon } from "../onboarding/ui";
import { blockedWords, defaultDevicePick, deviceValue, DEVICE_STATE_LABELS, pickerRows } from "../onboarding/device-picker";
import { rememberDevice, rememberedDevice } from "../onboarding/remembered-device";
import { useLiveDevices } from "../onboarding/use-live-devices";
import { errText, useLoad } from "../parts";
import { listScenarios, listTargets, PLATFORMS, type Platform } from "../qaApi";
import { platformWord, plural } from "../qaWords";
import { DEFAULT_QA_SETTINGS, getQaSettings } from "../requests/api";
import { qaAgentOf } from "../requests/model";
import { createQaTask, DEFAULT_MINUTES, qaTaskBody, TIMED_KINDS, type QaRunKind } from "../runQa";
import { queueSession } from "../sessions/api";
import { getDraftingSources } from "../sessions/drafting/api";
import { DraftSourcesPicker } from "../sessions/drafting/drafting-parts";
import { canStartChoice, defaultDraftChoice, type DraftChoice, type ExplorationSummary } from "../sessions/drafting/lib/draft-sources";
import { runHref } from "./runFlow";
import { RunPreview, type PreviewDevice } from "./RunPreview";

const SOURCE_WORDS: Record<DraftChoice, string> = { code: "From the code", past: "From the code and past runs", new: "From the code and a new exploration" };

/** Conditions a physical phone cannot take stop Start: the run would only report them unmet. */
function offPhoneBlock(c: Conditions | null, platform: Platform | null, row: { physical: boolean } | null): boolean {
  return Boolean(row?.physical && unavailableWords(c, platform, true));
}

export function RunOptions({ cid, auth, kind, params, patch }: {
  cid: string;
  auth: QaAuthority;
  kind: QaRunKind;
  params: URLSearchParams;
  patch: (next: Record<string, string | null>) => void;
}) {
  const { snap } = useSnapshot();
  const navigate = useNavigate();
  const ids = { focus: useId(), minutes: useId() };
  const targets = useLoad((s) => listTargets(cid, s), [cid]);
  const settingsRes = useLoad((s) => getQaSettings(cid, s), [cid]);
  const settings = settingsRes.data ?? DEFAULT_QA_SETTINGS;
  const ready = PLATFORMS.filter((p) => (targets.data ?? []).some((t) => t.platform === p && t.app_id));
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const asked = params.get("platform") as Platform | null;
  const platform: Platform | null = asked && ready.includes(asked) ? asked
    : settings.default_platform && ready.includes(settings.default_platform) ? settings.default_platform : ready[0] ?? null;
  const [agentId, setAgentId] = useState<string | null>(null);
  // The one picked, the project's QA agent, else whoever is there: Start is never waiting on a pick.
  const agent = agents.find((a) => a.id === agentId) ?? qaAgentOf(agents, settings) ?? agents[0] ?? null;
  const usesDevice = !!platform && kind !== "draft";
  const live = useLiveDevices(cid, usesDevice);
  // The pick made here ("": Default); none yet: the remembered one.
  const [chosen, setChosen] = useState<Partial<Record<Platform, string>>>({});
  const deviceKey = platform ? chosen[platform] ?? rememberedDevice(cid, platform) : "";
  const deviceRow = usePickedRow(live, deviceKey);
  const device = deviceRow ? deviceValue(deviceRow.device) : null;
  const blocked = usesDevice ? blockedWords(deviceRow) : null;
  const pickDevice = (key: string) => {
    if (!platform) return;
    setChosen((c) => ({ ...c, [platform]: key }));
    rememberDevice(cid, platform, key);
  };
  const [minutes, setMinutes] = useState(String(DEFAULT_MINUTES));
  const [focus, setFocus] = useState(params.get("focus") ?? "");
  const [conditions, setConditions] = useState<Conditions | null>(() => parseConditions(params.get("conditions")));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<DraftChoice | null>(null);
  const [explorations, setExplorations] = useState<ExplorationSummary | null>(null);
  const [openedAt] = useState(() => Date.now());
  useEffect(() => {
    const ctl = new AbortController();
    void getDraftingSources(cid, ctl.signal).then((s) => { if (!ctl.signal.aborted) setExplorations(s); }, () => {});
    return () => ctl.abort();
  }, [cid]);
  const scenarioIds = (params.get("scenarios") ?? "").split(",").filter(Boolean);
  const checking = kind === "check" && !scenarioIds.length;
  const scenarioList = useLoad(async (s) => (kind === "check" && platform ? await listScenarios(cid, platform, s) : null), [cid, platform, kind]);
  const approvedRows = (scenarioList.data ?? []).filter((x) => x.status === "validated");
  const approved = { data: scenarioList.data ? approvedRows.length : null };
  const nothingToCheck = checking && approved.data === 0;
  const runNames = scenarioIds.length ? (scenarioList.data ?? []).filter((x) => scenarioIds.includes(x.id)).map((x) => x.name) : approvedRows.map((x) => x.name);
  const [tab, setTab] = useState<"device" | "conditions" | "options">(() => (params.get("cond") === "1" || parseConditions(params.get("conditions")) ? "conditions" : "device"));
  const hasRepo = true; // an agent always works in the project's repository
  const hasTarget = ready.length > 0;
  const drafting = kind === "draft";
  const choice = picked ?? defaultDraftChoice({ hasRepo, explorations, hasTarget, now: openedAt });
  const timed = TIMED_KINDS.includes(kind) || (drafting && choice === "new");
  const mins = Number(minutes);
  const minutesBad = timed && (!Number.isFinite(mins) || mins < 5 || mins > 240);
  const sourcesBad = drafting && !canStartChoice(choice, { hasRepo, explorations, hasTarget });
  const canStart = auth.can && !!platform && !!agent && !minutesBad && !sourcesBad && !nothingToCheck && !blocked && !offPhoneBlock(conditions, platform, deviceRow) && !busy;

  const start = async () => {
    if (!platform || !agent || !canStart) return;
    setBusy(true);
    setErr(null);
    try {
      const body = qaTaskBody({ kind, platform, minutes: timed ? mins : null, focus, sources: drafting ? choice : null, scenarioIds: kind === "check" ? scenarioIds : null, device, conditions, agentAlias: agent.alias, humanId: auth.human?.id ?? null });
      const res = await createQaTask(cid, body);
      const tid = res?.task_id ? String(res.task_id) : null;
      const session = tid ? await queueSession(cid, { kind, platform, task_id: tid, goal: focus.trim() || null, budget_minutes: timed ? mins : null, agent_id: agent.id, draft_sources: drafting ? (choice === "past" ? "both" : "code") : null, conditions: cleanConditions(conditions), actor_agent_id: auth.human?.id ?? null }).catch(() => null) : null;
      // Replace: Back from the run goes where the person came from, never to a form already sent.
      if (session?.id) navigate(runHref({ id: session.id, platform }, params.get("from")), { replace: true });
      else if (tid) navigate("/tasks?task=" + encodeURIComponent(tid), { replace: true });
      else setErr("The run did not start. Try again.");
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  if (targets.data && !ready.length) {
    return (
      <div className="qa-setup qa-run-rise" data-qa-setup="app">
        <h2 className="qa-setup-t">No app is set yet</h2>
        <div className="qa-actions"><Button variant="primary" onClick={() => navigate("/qa?settings=1")}>Set the app</Button></div>
      </div>
    );
  }
  const conditionSaid = conditionWords(conditions, platform);
  const offPhone = usesDevice ? unavailableWords(conditions, platform, Boolean(deviceRow?.physical)) : null;
  const rows = pickerRows(live.devices);
  const previewDevice: PreviewDevice | null = !usesDevice || !platform ? null : deviceRow ? {
    title: deviceRow.title,
    state: deviceRow.state === "stopped" ? "Boots when the run starts" : DEVICE_STATE_LABELS[deviceRow.state],
    physical: deviceRow.physical,
    os: deviceRow.device.kind === "ios" ? (deviceRow.device.physical ? deviceRow.device.os : deviceRow.device.runtime) ?? null
      : deviceRow.device.kind === "android" ? deviceRow.device.os ?? null : null,
  } : { title: defaultDevicePick(platform, rows).noun, state: "Default", physical: false, os: null };
  const target = (targets.data ?? []).find((t) => t.platform === platform);
  const optionWords = [timed ? `${minutes} min` : null, drafting ? SOURCE_WORDS[choice] : null, focus.trim() ? `Focus: ${focus.trim()}` : null,
    conditionSaid.length ? conditionSaid.join(", ") : null].filter(Boolean).join(" · ");
  return (
    <div className="qa-run-form qa-run-rise">
      <div className="qa-run-head" data-run-head>
        <div className={"qa-run-plats" + (ready.length === 1 ? " is-one" : "")} role={ready.length > 1 ? "radiogroup" : undefined} aria-label={ready.length > 1 ? "Platform" : undefined}>
          {ready.map((p) => {
            const t = (targets.data ?? []).find((x) => x.platform === p);
            const on = p === platform;
            const inner = (
              <>
                <span className="qa-run-plat-ico" aria-hidden="true"><PlatformIcon kind={p} className="size-4" /></span>
                <span className="qa-run-plat-text">
                  <span className="qa-run-plat-name" {...(ready.length === 1 ? { "data-run-platform": "" } : {})}>{platformWord(p)}</span>
                  <code className="qa-run-plat-app">{t?.app_id ?? ""}</code>
                </span>
                {on && ready.length > 1 ? <span className="qa-run-plat-dot" aria-hidden="true" /> : null}
              </>
            );
            return ready.length > 1
              ? <button key={p} type="button" role="radio" aria-checked={on} className={"qa-run-plat" + (on ? " is-on" : "")} onClick={() => patch({ platform: p })} data-run-platform-card={p}>{inner}</button>
              : <div key={p} className="qa-run-plat is-on">{inner}</div>;
          })}
        </div>
        <div className="qa-run-meta">
          <div className="qa-run-who">
            <span className="qa-run-avatar" aria-hidden="true">{(agent?.alias ?? "?").slice(0, 1).toUpperCase()}</span>
            <span className="qa-run-who-text">
              <span className="qa-run-k">Runs it</span>
              {agents.length > 1 ? <MenuButton menuLabel="Agent" size="sm" variant="ghost" value={agent?.alias ?? "…"} items={agents.map((a) => ({ label: a.alias, hint: a.role || undefined, checked: agent?.id === a.id, onSelect: () => setAgentId(a.id) }))} />
                : <span className="qa-run-who-name" data-run-agent>{agent?.alias ?? "…"}</span>}
            </span>
          </div>
          {kind === "check" ? (
            <div className="qa-run-count">
              <span className="qa-run-k">Runs</span>
              <span className="qa-run-count-v" data-run-picked={scenarioIds.length}>{scenarioIds.length ? plural(scenarioIds.length, "picked scenario") : nothingToCheck ? "No approved scenarios yet" : approved.data ? plural(approved.data, "approved scenario") : "Every approved scenario"}</span>
            </div>
          ) : null}
        </div>
      </div>
      {nothingToCheck ? (
        <div className="qa-run-foot"><Button variant="primary" onClick={() => patch({ kind: "draft", chose: null })} data-run-draft-instead>Draft scenarios</Button></div>
      ) : (
        <>
          <div className="qa-run-tabs">
            <Tabs label="Run settings" value={usesDevice ? tab : "options"} onChange={(k) => setTab(k as typeof tab)} idPrefix="qa-run-tab" panelId="qa-run-tabpanel"
              tabs={[
                ...(usesDevice ? [{ key: "device", label: "Device", icon: "phone", badge: <span className="qa-muted"> {previewDevice?.title}</span> },
                  { key: "conditions", label: "Conditions", icon: "sliders", count: conditionSaid.length || null }] : []),
                { key: "options", label: "Options", icon: "gear", badge: optionWords ? <span className="qa-muted"> {timed ? `${minutes} min` : ""}</span> : undefined },
              ]} />
            <div className="qa-run-tabpanel" id="qa-run-tabpanel" role="tabpanel">
              {usesDevice && platform && tab === "device" ? <DeviceField live={live} platform={platform} pickKey={deviceKey} onPick={pickDevice} rememberPick /> : null}
              {usesDevice && tab === "conditions" ? <ConditionsField value={conditions} onChange={setConditions} platform={platform} physical={Boolean(deviceRow?.physical)} label="" /> : null}
              {!usesDevice || tab === "options" ? (
                <div className="qa-form">
                  {drafting ? <DraftSourcesPicker plain session={{ choice, setChoice: setPicked, explorations, hasRepo, hasTarget }} /> : null}
                  {timed ? (
                    <div className="qa-field">
                      <label className="qa-label" htmlFor={ids.minutes}>Minutes</label>
                      <input id={ids.minutes} className="qa-input qa-num" type="number" inputMode="numeric" min={5} max={240} step={5} value={minutes} aria-invalid={minutesBad || undefined} onChange={(e) => setMinutes(e.target.value)} />
                      {minutesBad ? <p className="qa-error" role="alert">Give it between 5 and 240 minutes.</p> : null}
                    </div>
                  ) : null}
                  <div className="qa-field">
                    <label className="qa-label" htmlFor={ids.focus}>Focus</label>
                    <input id={ids.focus} className="qa-input" value={focus} maxLength={200} placeholder={kind === "map" ? "A feature to map first" : "What to look at first"} onChange={(e) => setFocus(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {platform ? (
            <RunPreview kind={kind} platform={platform} app={target ? { name: target.app_name, id: target.app_id } : null} device={previewDevice} agent={agent?.alias ?? null}
              scenarios={kind === "check" ? { count: scenarioIds.length || approved.data, names: runNames.slice(0, 4), picked: scenarioIds.length > 0 } : null}
              minutes={timed && !minutesBad ? mins : null} focus={focus} conditions={conditions} inherited={kind === "check"} />
          ) : null}
          {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
          {blocked ? <p className="qa-muted qa-gate" data-run-device-blocked>{blocked}</p> : null}
          {offPhone ? <p className="qa-muted qa-gate" data-run-conditions-off-phone>{offPhone}</p> : null}
          {err ? <p className="qa-error" role="alert">{err}</p> : null}
          <div className="qa-run-foot">
            {drafting ? <span className="qa-muted" data-run-estimate>{choice === "new" ? "Usually about $6 to $9" : "Usually about $4 to $6"}</span> : null}
            <Button variant="primary" busy={busy} disabled={!canStart} onClick={() => void start()} data-run-start>Start</Button>
          </div>
        </>
      )}
    </div>
  );
}
