/**
 * Send to QA: the handoff from a task. Kind, platform, focus, the lines to prove (preloaded from the
 * task's definition of done) and what happens if it fails. Creates a request; its QA task goes to the
 * project's QA agent. The result comes back to this task as proof, for the project's verification rule.
 */
import { ConditionsField } from "../conditions/ConditionsField";
import { cleanConditions, conditionWords, type Conditions } from "../conditions/conditions";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Dialog, IconButton, Segmented } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import { qaAuthority } from "../authority";
import { errText, useLoad } from "../parts";
import { getOverview, listScenarios, listTargets, PLATFORMS, type Platform, type SessionKind } from "../qaApi";
import { platformWord, plural } from "../qaWords";
import { QA_RUN_KINDS } from "../runQa";
import { requestsChanged } from "../../../state/qaRequestBus";
import { cleanBuild, DEFAULT_QA_SETTINGS, getQaSettings, sendTaskToQa, type QaOnFail, type QaRequestBuild } from "./api";
import { requestIdHref } from "./links";
import { dodLines, qaAgentOf } from "./model";
import { ON_FAIL } from "./words";
import { finishProjectLine } from "../runTask/finishing";

export interface SendToQaTask {
  id: string;
  title: string;
  definition_of_done?: string | null;
  /** What decides whether "Send to Quality when finished" shows: not on a workflow's step, the root task or a finished one. */
  workflow_id?: string | null;
  is_root?: boolean;
  status?: string;
}

const MAX_LINES = 30;

export function SendToQaDialog({ task, onClose }: { task: SendToQaTask; onClose: () => void }) {
  const { cid, snap } = useSnapshot();
  const auth = qaAuthority(useActingAuthority());
  const toast = useToast();
  const navigate = useNavigate();
  const ids = { focus: useId(), branch: useId(), commit: useId(), notes: useId() };
  const targets = useLoad(cid ? (s) => listTargets(cid, s) : null, [cid]);
  const settingsRes = useLoad(cid ? (s) => getQaSettings(cid, s) : null, [cid]);
  const settings = settingsRes.data ?? DEFAULT_QA_SETTINGS;
  const ready = PLATFORMS.filter((p) => (targets.data ?? []).some((t) => t.platform === p && t.app_id));
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const qaAgent = qaAgentOf(agents, settings);

  const [chosenKind, setKind] = useState<SessionKind | null>(null);
  const [chosen, setChosen] = useState<Platform | null>(null);
  const platform: Platform | null = chosen && ready.includes(chosen) ? chosen
    : settings.default_platform && ready.includes(settings.default_platform) ? settings.default_platform : ready[0] ?? null;
  // The server's default: a check when there are approved scenarios to run, else an exploration.
  const overview = useLoad(cid ? (s) => getOverview(cid, s) : null, [cid]);
  const kind: SessionKind = chosenKind ?? (platform && overview.data?.[platform].scenarios.validated ? "check" : "explore");
  const scenarios = useLoad(cid && platform && kind === "check" ? (s) => listScenarios(cid, platform, s) : null, [cid, platform, kind]);
  const approved = (scenarios.data ?? []).filter((s) => s.status === "validated");
  const [picked, setPicked] = useState<string[]>([]);
  const [focus, setFocus] = useState("");
  const [lines, setLines] = useState<string[]>(() => dodLines(task.definition_of_done));
  const [onFail, setOnFail] = useState<QaOnFail | null>(null);
  const failChoice = onFail ?? settings.on_fail;
  const [build, setBuild] = useState<QaRequestBuild>({});
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setErr(null); setPicked([]); }, [kind, platform]);

  const loading = !targets.data && !targets.error;
  const kept = lines.map((l) => l.trim()).filter(Boolean);
  const canSubmit = auth.can && !!platform && !busy;
  const setLine = (i: number, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? v : l)));

  const submit = async () => {
    if (!platform) { setErr("Set the app for a platform first."); return; }
    if (!auth.can) { setErr(auth.reason || "Only a person can send work to QA from here."); return; }
    setBusy(true);
    setErr(null);
    try {
      const { request } = await sendTaskToQa(task.id, auth.human?.id ?? null, {
        kind, platform, scenario_ids: kind === "check" ? picked : [], focus: focus.trim() || null, acceptance: kept, on_fail: failChoice, build: cleanBuild(build),
        conditions: cleanConditions(conditions),
      });
      requestsChanged();
      toast(`Sent to QA: ${task.title}`, "ok", { action: { label: "Open request", onClick: () => navigate(requestIdHref(request.id)) } });
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Send to QA" size="md" onClose={onClose}
      description={`The QA agent${qaAgent ? ` (${qaAgent.alias})` : ""} takes it. The result comes back to this task as proof.`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!canSubmit} onClick={() => void submit()}>Send to QA</Button>
      </>}>
      <form className="qa-form" data-send-to-qa onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="qa-field">
          <span className="qa-label">What</span>
          <Segmented size="sm" label="What QA does" value={kind} onChange={(k) => setKind(k as SessionKind)} items={QA_RUN_KINDS.map((k) => ({ key: k.key, label: k.label }))} />
          <span className="qa-hint">{QA_RUN_KINDS.find((k) => k.key === kind)!.hint}</span>
        </div>
        <div className="qa-field">
          <span className="qa-label">Platform</span>
          {loading ? <span className="qa-hint">Loading the apps…</span> : ready.length ? (
            <Segmented size="sm" label="Platform to test on" value={platform ?? ""} onChange={(k) => setChosen(k as Platform)} items={ready.map((p) => ({ key: p, label: platformWord(p) }))} />
          ) : (
            <div className="qa-inline-note" role="note">
              <span>No app is set yet. QA needs to know which app or site to open.</span>
              <Button size="sm" variant="link" onClick={() => { onClose(); navigate("/qa?settings=1"); }}>Set the app</Button>
            </div>
          )}
        </div>
        {kind === "check" && platform ? (
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
            ) : <span className="qa-hint">{scenarios.data ? `No approved scenarios on ${platformWord(platform)} yet.` : "Loading the scenarios…"}</span>}
          </div>
        ) : null}
        <div className="qa-field">
          <label className="qa-label" htmlFor={ids.focus}>Focus <span className="qa-muted">(optional)</span></label>
          <input id={ids.focus} className="qa-input" value={focus} maxLength={200} placeholder="What to look at first, e.g. sign-up and password reset" onChange={(e) => setFocus(e.target.value)} />
        </div>
        <div className="qa-field" role="group" aria-label="Lines to prove">
          <span className="qa-label">Lines to prove <span className="qa-muted">{kept.length ? `(${plural(kept.length, "line")})` : "(optional)"}</span></span>
          {lines.length ? (
            <ol className="qa-plain qa-lines">
              {lines.map((l, i) => (
                <li key={i} className="qa-line-row">
                  <input className="qa-input" aria-label={`Line ${i + 1}`} value={l} maxLength={500} onChange={(e) => setLine(i, e.target.value)} />
                  <IconButton icon="x" size="sm" label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
                </li>
              ))}
            </ol>
          ) : <span className="qa-hint">This task's definition of done has no lines. Add what QA should prove.</span>}
          <div><Button size="sm" variant="ghost" icon="plus" disabled={lines.length >= MAX_LINES} onClick={() => setLines((ls) => [...ls, ""])}>Add line</Button></div>
        </div>
        <div className="qa-field">
          <span className="qa-label">If it fails</span>
          <Segmented size="sm" label="If it fails" value={failChoice} onChange={(k) => setOnFail(k as QaOnFail)} items={ON_FAIL.map((o) => ({ key: o.key, label: o.label }))} />
          <span className="qa-hint">
            {ON_FAIL.find((o) => o.key === failChoice)!.hint}
            {failChoice === "reopen" ? ` Up to ${plural(settings.max_rounds, "round")}.` : ""} {finishProjectLine(settings.finish_when_proven)}
          </span>
        </div>
        <details className="qa-disclosure">
          <summary>Conditions <span className="qa-muted">{conditionWords(conditions, platform).join(", ") || "(optional)"}</span></summary>
          <ConditionsField label="" value={conditions} onChange={setConditions} platform={platform} />
        </details>
        <details className="qa-disclosure">
          <summary>What to test <span className="qa-muted">(optional)</span></summary>
          <div className="qa-form">
            <div className="qa-field">
              <label className="qa-label" htmlFor={ids.branch}>Branch</label>
              <input id={ids.branch} className="qa-input qa-mono" value={build.branch ?? ""} maxLength={200} onChange={(e) => setBuild((b) => ({ ...b, branch: e.target.value }))} />
            </div>
            <div className="qa-field">
              <label className="qa-label" htmlFor={ids.commit}>Commit</label>
              <input id={ids.commit} className="qa-input qa-mono" value={build.commit ?? ""} maxLength={80} onChange={(e) => setBuild((b) => ({ ...b, commit: e.target.value }))} />
            </div>
            <div className="qa-field">
              <label className="qa-label" htmlFor={ids.notes}>Notes for QA</label>
              <textarea id={ids.notes} className="qa-input qa-textarea" rows={2} maxLength={2000} value={build.notes ?? ""} onChange={(e) => setBuild((b) => ({ ...b, notes: e.target.value }))} />
            </div>
          </div>
        </details>
        {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
        {err ? <p className="qa-error" role="alert">{err}</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
