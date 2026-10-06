/**
 * Metrics → "Monthly budgets": spend vs budget bars (GET /api/containers/{cid}/budgets).
 *
 * One row per budgeted scope (the optional project cap first, then each agent with a
 * limit): name, the USD bar (and a token bar when a cap is set), "$x of $y", and a health
 * chip from the REAL verdict. Missing-cost honesty (brief §3): when nothing in the month
 * reported a dollar figure the USD cell reads "not metered", never $0; partly-metered months
 * say how many runs were not metered. The scope line names the UTC month and reset day.
 *
 * `agentId` narrows it to one agent (the spend drilldown). A server without the budgets
 * route (404) renders nothing.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Avatar, Button, HealthChip } from "../../components/primitives";
import { grantDenied, NO_ACTING_HUMAN } from "../../pages/agents/agentModel";
import { BudgetMeter } from "../../pages/agents/budget/AgentBudgetSection";
import {
  announceBudgetChange,
  budgetHealth,
  parseLimit,
  putContainerBudget,
  type BudgetUpdate,
  type ContainerBudgets,
  fmtPeriod,
  fmtReset,
  fmtTok,
  fmtUsd,
  pctLabel,
  spendUnknown,
  useContainerBudgets,
  type BudgetScope,
} from "../../pages/agents/budget/budgetModel";
import { actingHuman, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import "./budgetBars.css";

const NOT_METERED_TIP =
  "No run this month reported a dollar cost (subscription billing, Codex or an unpriced model) — the spend is unknown, not $0.";

// M13: budget token figures count prompt-cache reads/writes (what a token cap
// meters); the Metrics Tokens column excludes cache — so label the difference.
const CACHE_TIP =
  "Includes prompt-cache reads and writes, which count toward the token cap. The Tokens column above excludes cache, so these figures are larger.";

const PART_METERED_TIP =
  "These runs reported no dollar cost (subscription billing, Codex or an unpriced model). They are not counted as $0 — a token cap bounds them.";

function UsdCell({ s }: { s: BudgetScope }) {
  if (s.limits.usd == null) return <span className="bb-none">No dollar limit</span>;
  if (spendUnknown(s.usage)) {
    return <span className="bb-none" title={NOT_METERED_TIP}>Not metered · limit {fmtUsd(s.limits.usd)}</span>;
  }
  return (
    <span className="bb-val">
      <span className="bb-fig">{fmtUsd(s.usage.spend_usd)}</span>
      <span className="bb-of"> of {fmtUsd(s.limits.usd)}</span>
      <span className="bb-pct"> · {pctLabel(s.usd_ratio)}</span>
    </span>
  );
}

function BudgetRow({ name, glyph, s, reason, to, actions }: {
  name: string; glyph: ReactNode; s: BudgetScope; reason?: string | null; to?: string;
  /** the project row's owner controls (Set cap / Edit / Override / Revoke) */
  actions?: ReactNode;
}) {
  const health = budgetHealth(s);
  const unmetered = s.usage.unmetered_runs;
  return (
    <li className="bb-row" data-state={s.state}>
      <span className="bb-name">
        {glyph}
        {to ? <Link to={to} className="bb-link" title={name}>{name}</Link> : <span className="bb-nm" title={name}>{name}</span>}
      </span>
      <span className="bb-bars">
        <span className="bb-line">
          {s.limits.usd != null && !spendUnknown(s.usage) ? <BudgetMeter ratio={s.usd_ratio} label={name + " spend against budget"} /> : <span className="bb-meter-gap" />}
          <UsdCell s={s} />
        </span>
        {s.limits.tokens != null ? (
          <span className="bb-line">
            <BudgetMeter ratio={s.token_ratio} label={name + " tokens against cap"} />
            <span className="bb-val">
              <span className="bb-fig">{fmtTok(s.usage.tokens)}</span>
              <span className="bb-of"> of {fmtTok(s.limits.tokens)} tokens</span>
              <span className="bb-pct" title={CACHE_TIP}> · incl. cache</span>
            </span>
          </span>
        ) : null}
        {unmetered > 0 && !spendUnknown(s.usage) && s.limits.usd != null ? (
          <span className="bb-sub" title={PART_METERED_TIP}>
            + {unmetered} {unmetered === 1 ? "run" : "runs"} not metered ({fmtTok(s.usage.unmetered_tokens)} tokens incl. cache)
          </span>
        ) : null}
      </span>
      <span className="bb-health">
        {health ? <HealthChip health={health.health} label={health.label} title={reason || health.label} /> : null}
        {actions}
      </span>
    </li>
  );
}

type ProjMode = "view" | "edit" | "override";

/**
 * The project-wide cap's controls (KG-5 / B14 / PS-20 / M07): an owner or a
 * manage_autonomy holder sets / edits / clears the cap and grants or revokes the
 * one-time override (PUT /api/containers/{cid}/budget). Everyone else sees the
 * row read-only with the reason in the lock's tooltip — never a form that 403s.
 */
function useProjectBudgetEditor(cid: string, data: ContainerBudgets, setData: (d: ContainerBudgets) => void) {
  const { snap, identity } = useSnapshot();
  const authority = useActingAuthority();
  const denied = grantDenied(snap, identity, "manage_autonomy", authority.reason || NO_ACTING_HUMAN);
  const me = actingHuman(snap);
  const canEdit = !denied && !!me;
  const [mode, setMode] = useState<ProjMode>("view");
  const [busy, setBusy] = useState(false);
  const [usdIn, setUsdIn] = useState("");
  const [tokIn, setTokIn] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const p = data.project;
  const hasCap = p.limits.usd != null || p.limits.tokens != null;

  const send = (body: BudgetUpdate, ok: string) => {
    if (!canEdit || !me) return;
    setBusy(true);
    setMsg(null);
    putContainerBudget(cid, { actor_agent_id: String(me.id), ...body })
      .then((d) => {
        if (d && d.project) setData(d);
        // B14c: the Shell's "Budget paused" chip (and roster/board chips) re-read now,
        // not on their next 60 s poll.
        announceBudgetChange();
        setMode("view");
        setNote("");
        setMsg({ tone: "ok", text: ok });
      })
      .catch((e: Error) => setMsg({ tone: "err", text: "Project budget change failed — " + e.message }))
      .finally(() => setBusy(false));
  };
  const startEdit = () => {
    setUsdIn(p.limits.usd != null ? String(p.limits.usd) : "");
    setTokIn(p.limits.tokens != null ? String(p.limits.tokens) : "");
    setMsg(null);
    setMode("edit");
  };
  const onSave = (e: FormEvent) => {
    e.preventDefault();
    const usd = parseLimit(usdIn, false);
    const tokens = parseLimit(tokIn, true);
    if (usd === undefined || tokens === undefined) {
      setMsg({ tone: "err", text: "Enter a positive number, or leave blank for no limit." });
      return;
    }
    send({ monthly_limit_usd: usd, monthly_limit_tokens: tokens }, usd == null && tokens == null ? "Project budget removed" : "Project budget saved");
  };

  const actions = canEdit && mode === "view" ? (
    <span className="bb-acts">
      {p.paused ? <Button size="sm" variant="ghost" onClick={() => { setMsg(null); setMode("override"); }}>Override this month</Button> : null}
      {p.override.active ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => send({ override: "revoke" }, "Project override revoked")}>Revoke override</Button> : null}
      <Button size="sm" variant={hasCap ? "ghost" : "secondary"} icon={hasCap ? "sliders" : "plus"} onClick={startEdit} id="bbProjEdit">
        {hasCap ? "Edit" : "Set project budget"}
      </Button>
    </span>
  ) : !canEdit && hasCap ? (
    <span className="bb-lock" tabIndex={0} title={denied || NO_ACTING_HUMAN}>Read-only</span>
  ) : null;

  const panel = (
    <>
      {mode === "edit" ? (
        <form className="bdg-form bb-form" onSubmit={onSave} aria-label="Edit project budget">
          <label className="bdg-field">
            <span className="bdg-lbl">Project monthly limit (USD)</span>
            <span className="bdg-in-wrap">
              <span className="bdg-in-pre" aria-hidden="true">$</span>
              <input className="bdg-in tnum" inputMode="decimal" value={usdIn} placeholder="No limit" aria-label="Project monthly limit in US dollars" onChange={(e) => setUsdIn(e.target.value)} autoFocus />
            </span>
          </label>
          <label className="bdg-field">
            <span className="bdg-lbl">Project token cap</span>
            <input className="bdg-in tnum" inputMode="numeric" value={tokIn} placeholder="No cap" aria-label="Project monthly token cap" onChange={(e) => setTokIn(e.target.value)} />
          </label>
          <p className="bdg-desc bdg-form-note">
            Covers every agent together. At 80% you get a Needs-you notice; at 100% every agent is paused for new runs. A run already in progress is not stopped. Leave both blank to remove the cap.
          </p>
          <span className="bdg-acts">
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
          </span>
        </form>
      ) : null}
      {mode === "override" ? (
        <form className="bdg-form bb-form" aria-label="Grant a one-time project override"
          onSubmit={(e) => { e.preventDefault(); send({ override: "grant", note: note.trim() || null }, "Project override granted until " + fmtReset(data.resets_at)); }}>
          <p className="bdg-desc bdg-form-note">
            Lets every agent start new runs for the rest of {fmtPeriod(data.period)} despite the project cap. It ends on {fmtReset(data.resets_at)} and is recorded in the audit log.
          </p>
          <input className="bdg-in" value={note} maxLength={500} placeholder="Reason (optional)" aria-label="Override reason" onChange={(e) => setNote(e.target.value)} autoFocus />
          <span className="bdg-acts">
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" busy={busy}>Grant override</Button>
          </span>
        </form>
      ) : null}
      {p.override.active && mode === "view" ? (
        <p className="bb-foot bb-none" id="bbProjOverride" title={p.override.note || undefined}>
          Project override active until {fmtReset(data.resets_at)}{p.override.note ? " · “" + p.override.note + "”" : ""}
        </p>
      ) : null}
      {msg ? <p className={"bb-foot " + (msg.tone === "err" ? "bdg-err" : "bb-none")} role={msg.tone === "err" ? "alert" : "status"}>{msg.text}</p> : null}
    </>
  );
  return { canEdit, actions, panel };
}

export function BudgetBars({ cid, agentId }: { cid: string; agentId?: string | null }) {
  const { data, error, unsupported, setData } = useContainerBudgets(cid);
  if (unsupported) return null;
  if (error && !data) {
    return (
      <section className="mx-sec bb" aria-labelledby="bbH">
        <div className="mx-sec-h"><h2 id="bbH">Monthly budgets</h2></div>
        <p className="mx-quiet">Budgets are temporarily unavailable — {error}</p>
      </section>
    );
  }
  if (!data) return null;
  return <BudgetBarsBody cid={cid} agentId={agentId} data={data} setData={setData} />;
}

function BudgetBarsBody({ cid, agentId, data, setData }: {
  cid: string; agentId?: string | null; data: ContainerBudgets; setData: (d: ContainerBudgets) => void;
}) {
  const proj = useProjectBudgetEditor(cid, data, setData);
  const agents = data.agents.filter((a) => (agentId ? String(a.agent_id) === String(agentId) : a.state !== "none"));
  // the project row shows when a cap exists — and always to someone who can set one
  const project = !agentId && (data.project.state !== "none" || proj.canEdit) ? data.project : null;
  const unbudgeted = agentId ? 0 : data.agents.filter((a) => a.state === "none").length;
  if (agentId && (!agents.length || agents[0].state === "none") && data.project.state === "none") return null;

  return (
    <section className="mx-sec bb" aria-labelledby="bbH" id="mxBudgets">
      <div className="mx-sec-h">
        <h2 id="bbH">Monthly budgets</h2>
        <span className="count">{fmtPeriod(data.period)} · resets {fmtReset(data.resets_at)} (UTC)</span>
      </div>
      {project || agents.some((a) => a.state !== "none") ? (
        <ul className="bb-list">
          {project ? (
            <BudgetRow name="Whole project" glyph={<span className="bb-proj" aria-hidden="true" />} s={project} reason={data.project.reason} actions={proj.actions} />
          ) : null}
          {agents
            .filter((a) => a.state !== "none")
            .map((a) => (
              <BudgetRow
                key={a.agent_id}
                name={a.alias || "Agent"}
                glyph={<Avatar alias={a.alias || "?"} kind="ai" size={20} decorative />}
                s={a}
                reason={a.reason}
                to={agentId ? undefined : "/agents?agent=" + encodeURIComponent(a.alias || "") + "&tab=config"}
              />
            ))}
        </ul>
      ) : null}
      {!agentId ? proj.panel : null}
      {agentId && agents[0] && agents[0].blocked_by === "project" ? (
        <p className="mx-quiet bb-foot">{agents[0].reason}</p>
      ) : null}
      {!agentId && data.project.state === "none" && !agents.length && !proj.canEdit ? (
        <p className="mx-quiet bb-foot" id="bbEmpty">No monthly budgets set. Set one in an agent’s Configuration tab.</p>
      ) : unbudgeted > 0 ? (
        <p className="bb-foot bb-none">{unbudgeted} {unbudgeted === 1 ? "agent has" : "agents have"} no budget.</p>
      ) : null}
    </section>
  );
}
