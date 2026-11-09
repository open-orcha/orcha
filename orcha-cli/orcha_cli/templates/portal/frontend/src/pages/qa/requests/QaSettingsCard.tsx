/**
 * QA settings (the settings dialog): the project's QA agent, its default platform, when work goes to QA by
 * itself, what a failure does, and how many rounds a fix can take. A person's call; everyone reads.
 */
import { useEffect, useId, useState } from "react";
import { Button, ConfirmDialog, MenuButton, Segmented, Skeleton, Tooltip } from "../../../components/primitives";
import { useToast } from "../../../components/ui";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { errText, useLoad } from "../parts";
import { PLATFORMS, type Platform } from "../qaApi";
import { platformWord } from "../qaWords";
import { getQaSettings, MAX_ROUNDS, MIN_ROUNDS, saveQaSettings, type QaAutoTriage, type QaOnFail, type QaSettings, type QaTrigger } from "./api";
import { qaAgentOf } from "./model";
import { AUTO_TRIAGE, ON_FAIL, TRIGGERS } from "./words";
import { relTime } from "../../../lib/format";
import { FINISH_ALONE_HINT, FINISH_ALONE_LABEL, FINISH_ALONE_STAYS } from "../runTask/finishing";
import { disableQaTools, enableQaTools, getQaSetup } from "../setup/setup";

/** Saved on its own, not by the card's Save: the comparison leaves it out. */
const withoutFinish = (s: QaSettings) => ({ ...s, finish_when_proven: false, finish_enabled_by: null, finish_enabled_at: null });

export function QaSettingsCard({ cid, auth, nonce }: { cid: string; auth: QaAuthority; nonce: number }) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const roundsId = useId();
  const perRunId = useId();
  const res = useLoad((s) => getQaSettings(cid, s), [cid], nonce);
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const [draft, setDraft] = useState<QaSettings | null>(null);
  const [rounds, setRounds] = useState<string | null>(null);
  const [perRun, setPerRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [toolsTick, setToolsTick] = useState(0);
  const [toolsBusy, setToolsBusy] = useState(false);
  const setup = useLoad((s) => getQaSetup(cid, s), [cid, toolsTick]);
  useEffect(() => { if (res.data && !draft) setDraft(res.data); }, [res.data, draft]);
  const cur = draft ?? res.data;
  if (res.status === 404) return null; // an older server: no settings yet
  if (!cur) return <section className="qa-card qa-settings" aria-label="QA settings"><Skeleton lines={3} label="Loading QA settings" /></section>;

  const roleAgent = qaAgentOf(agents, null);
  const roundsText = rounds ?? String(cur.max_rounds);
  const roundsNum = Number(roundsText);
  const roundsBad = !Number.isInteger(roundsNum) || roundsNum < MIN_ROUNDS || roundsNum > MAX_ROUNDS;
  const perRunText = perRun ?? String(cur.max_per_run);
  const perRunNum = Number(perRunText);
  const perRunBad = !Number.isInteger(perRunNum) || perRunNum < 1 || perRunNum > 20;
  const next: QaSettings = { ...cur, max_rounds: roundsBad ? cur.max_rounds : roundsNum, max_per_run: perRunBad ? cur.max_per_run : perRunNum };
  const dirty = !!res.data && JSON.stringify(withoutFinish(next)) !== JSON.stringify(withoutFinish(res.data));
  const set = (patch: Partial<QaSettings>) => setDraft({ ...cur, ...patch });
  const agent = cur.agent_id ? agents.find((a) => a.id === cur.agent_id) ?? null : null;
  const alias = agent?.alias ?? cur.agent_alias;
  const named = cur.agent_source === "set";

  const save = async () => {
    if (roundsBad) { setErr(`Give it between ${MIN_ROUNDS} and ${MAX_ROUNDS} rounds.`); return; }
    setBusy(true);
    setErr(null);
    try {
      const saved = await saveQaSettings(cid, auth.human?.id ?? null, next);
      setDraft(saved);
      setRounds(null);
      setPerRun(null);
      toast("QA settings saved", "ok");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const setTools = async (on: boolean) => {
    setToolsBusy(true);
    setErr(null);
    try {
      await (on ? enableQaTools : disableQaTools)(cid, auth.human?.id ?? null);
      setToolsTick((n) => n + 1);
      toast(on ? "QA tools on" : "QA tools off", "ok");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setToolsBusy(false);
    }
  };

  const setFinish = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      // Only this choice: fields still being edited wait for their own Save.
      const saved = await saveQaSettings(cid, auth.human?.id ?? null, { ...(res.data ?? cur), finish_when_proven: on });
      setDraft({ ...cur, finish_when_proven: saved.finish_when_proven, finish_enabled_by: saved.finish_enabled_by, finish_enabled_at: saved.finish_enabled_at });
      setConfirming(false);
      toast(on ? "Work can now finish by itself when everything is proven" : "A person verifies all work again", "ok");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const saveBtn = <Button size="sm" variant="primary" busy={busy} disabled={!auth.can || !dirty || roundsBad || perRunBad} onClick={() => void save()}>Save</Button>;
  return (
    <section className="qa-card qa-settings" aria-label="QA settings" data-qa-settings>
      <div className="qa-card-h">
        <div className="qa-card-t">
          <h3 className="qa-card-title">QA settings</h3>
          <div className="qa-card-sub">Who takes QA work, and when it runs by itself.</div>
        </div>
        {auth.can ? saveBtn : <Tooltip label={auth.reason || "Only a person can change QA settings"} placement="bottom">{saveBtn}</Tooltip>}
      </div>
      <div className="qa-settings-grid">
        <div className="qa-field">
          <span className="qa-label">QA agent</span>
          <MenuButton menuLabel="QA agent" size="sm" disabled={!auth.can} value={!alias ? "Choose an agent" : named ? alias : `${alias} (from its role)`}
            items={[
              { label: "The agent whose role says QA", checked: !named, onSelect: () => set({ agent_id: roleAgent?.id ?? null, agent_source: roleAgent ? "role" : "none" }) },
              "separator",
              ...agents.map((a) => ({ label: a.alias, hint: a.role || undefined, checked: named && cur.agent_id === a.id, onSelect: () => set({ agent_id: a.id, agent_source: "set" }) })),
            ]} />
          {!alias ? <span className="qa-hint">{agents.length ? "No agent's role says QA. Choose one, or requests wait." : "This project has no AI agents yet."}</span> : null}
        </div>
        <div className="qa-field">
          <span className="qa-label">Default platform</span>
          <Segmented size="sm" label="Default platform" value={cur.default_platform ?? ""} onChange={(k) => { if (auth.can) set({ default_platform: k as Platform }); }}
            items={PLATFORMS.map((p) => ({ key: p, label: platformWord(p) }))} />
        </div>
        <div className="qa-field">
          <span className="qa-label">When QA runs by itself</span>
          <Segmented size="sm" label="When QA runs by itself" value={cur.trigger} onChange={(k) => { if (auth.can) set({ trigger: k as QaTrigger }); }} items={TRIGGERS.map((t) => ({ key: t.key, label: t.label }))} />
          <span className="qa-hint">{TRIGGERS.find((t) => t.key === cur.trigger)!.hint}</span>
        </div>
        <div className="qa-field">
          <span className="qa-label">If it fails</span>
          <Segmented size="sm" label="If it fails" value={cur.on_fail} onChange={(k) => { if (auth.can) set({ on_fail: k as QaOnFail }); }} items={ON_FAIL.map((o) => ({ key: o.key, label: o.label }))} />
          <span className="qa-hint">{ON_FAIL.find((o) => o.key === cur.on_fail)!.hint}</span>
        </div>
        <div className="qa-field">
          <label className="qa-label" htmlFor={roundsId}>Most rounds</label>
          <input id={roundsId} className="qa-input qa-num" type="number" inputMode="numeric" min={MIN_ROUNDS} max={MAX_ROUNDS} step={1} disabled={!auth.can} value={roundsText} aria-invalid={roundsBad || undefined} onChange={(e) => setRounds(e.target.value)} />
          <span className="qa-hint">How many times a task can come back to QA before a person decides.</span>
        </div>
        <div className="qa-field">
          <span className="qa-label">Automatic triage</span>
          <Segmented size="sm" label="Automatic triage" value={cur.auto_triage} onChange={(k) => { if (auth.can) set({ auto_triage: k as QaAutoTriage }); }} items={AUTO_TRIAGE.map((t) => ({ key: t.key, label: t.label }))} />
          <span className="qa-hint">{AUTO_TRIAGE.find((t) => t.key === cur.auto_triage)!.hint}</span>
        </div>
        {cur.auto_triage !== "off" ? (
          <div className="qa-field">
            <label className="qa-label" htmlFor={perRunId}>Most findings per run</label>
            <input id={perRunId} className="qa-input qa-num" type="number" inputMode="numeric" min={1} max={20} step={1} disabled={!auth.can} value={perRunText} aria-invalid={perRunBad || undefined} onChange={(e) => setPerRun(e.target.value)} />
          </div>
        ) : null}
      </div>
      {setup.data?.can_enable ? (
        <div className="qa-field qa-finish" data-qa-tools-setting>
          <span className="qa-label">QA tools</span>
          <div>
            <Segmented size="sm" label="QA tools" value={setup.data.tools_on ? "on" : "off"}
              onChange={(k) => { if (auth.can && !toolsBusy) void setTools(k === "on"); }}
              items={[{ key: "off", label: "Off" }, { key: "on", label: "On" }]} />
          </div>
          <span className="qa-hint">{setup.data.tools_on ? "This project's agents can drive a device or a browser. Off takes effect from their next run." : "Off: this project's agents have no QA tools, and Run check asks you to turn them on first."}</span>
        </div>
      ) : null}
      <div className="qa-field qa-finish" data-finish-setting>
        <span className="qa-label">{FINISH_ALONE_LABEL}</span>
        <div>
          <Segmented size="sm" label={FINISH_ALONE_LABEL} value={cur.finish_when_proven ? "on" : "off"}
            onChange={(k) => { if (!auth.can || busy) return; if (k === "on") setConfirming(true); else void setFinish(false); }}
            items={[{ key: "off", label: "Off" }, { key: "on", label: "On" }]} />
        </div>
        <span className="qa-hint">{FINISH_ALONE_HINT}</span>
        {cur.finish_when_proven ? <span className="qa-hint" data-finish-enabled-by>{cur.finish_enabled_by ? `Turned on by ${cur.finish_enabled_by}${cur.finish_enabled_at ? `, ${relTime(cur.finish_enabled_at)}` : ""}.` : "Turned on."} Everything else still comes to a person.</span> : null}
      </div>
      {confirming ? (
        <ConfirmDialog title={`Turn on “${FINISH_ALONE_LABEL}”?`} confirmLabel="Turn it on" cancelLabel="Keep a person verifying" busy={busy} onClose={() => setConfirming(false)} onConfirm={() => void setFinish(true)}
          description="Work that meets the rule finishes with no person looking at it. Your name is recorded on every task it finishes.">
          <p className="qa-finish-k">These still come to a person:</p>
          <ul className="qa-finish-list">{FINISH_ALONE_STAYS.map((s) => <li key={s}>{s}</li>)}</ul>
        </ConfirmDialog>
      ) : null}
      {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
      {res.error && res.data ? <p className="qa-muted qa-gate">Showing the last loaded settings.</p> : null}
      {err ? <p className="qa-error" role="alert">{err}</p> : null}
    </section>
  );
}

