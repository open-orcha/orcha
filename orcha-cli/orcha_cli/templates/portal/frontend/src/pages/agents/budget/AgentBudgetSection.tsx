/**
 * <AgentBudgetSection agent={a} /> — the agent Configuration tab's "Budget" section.
 *
 * Self-contained: reads the acting human + grants from the snapshot, fetches
 * GET /api/agents/{aid}/budget (on mount + every 60s), writes PUT /api/agents/{aid}/budget.
 *
 * Truthful-data rules (brief §3): a run that reported no dollar figure is "not metered",
 * never $0; "Paused" only when the server says so, with its reason; a pause never implies
 * an in-flight run was stopped (it wasn't). Human authority: owner / manage_autonomy edit,
 * everyone else reads (controls hidden, a lock chip says why).
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Icon, useToast } from "../../../components/ui";
import { Button, HealthChip, HelpTip } from "../../../components/primitives";
import { actingHuman, useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import type { Agent } from "../../../types";
import { grantDenied, NO_ACTING_HUMAN } from "../agentModel";
import {
  BUDGET_REFRESH_MS,
  budgetHealth,
  fetchAgentBudget,
  fmtPeriod,
  fmtReset,
  fmtTok,
  fmtUsd,
  isAgentBudget,
  meterPct,
  meterTone,
  parseLimit,
  pctLabel,
  putAgentBudget,
  announceBudgetChange,
  spendUnknown,
  type AgentBudget,
  type AgentBudgetStatus,
  type BudgetUpdate,
} from "./budgetModel";
import "./budget.css";

const NOT_METERED_TIP =
  "These runs reported no dollar cost — usually subscription billing (Claude Code on your own login), Codex, or a model without a price. They are not counted as $0 of spend. A token cap bounds them too.";
const IN_FLIGHT_TIP = "A budget never stops a run that is already in progress — it only prevents new runs from starting.";

/* ---- connected wrapper ---------------------------------------------------- */

export function AgentBudgetSection({ agent }: { agent: Pick<Agent, "id" | "alias" | "kind"> }) {
  const { snap, identity } = useSnapshot();
  const authority = useActingAuthority();
  if (agent.kind === "human") return null;
  const denied = grantDenied(snap, identity, "manage_autonomy", authority.reason || NO_ACTING_HUMAN);
  const me = actingHuman(snap);
  return <AgentBudgetPanel agentId={String(agent.id)} alias={agent.alias || "This agent"} actorId={me ? String(me.id) : null} denied={denied} />;
}

/* ---- meter ------------------------------------------------------------------ */

export function BudgetMeter({ ratio, label }: { ratio: number | null; label: string }) {
  const pct = meterPct(ratio);
  return (
    <span
      className={"bdg-meter is-" + meterTone(ratio)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={pctLabel(ratio) + " of limit"}
    >
      <span className="bdg-meter-fill" style={{ "--w": pct + "%" } as CSSProperties} />
      <span className="bdg-meter-tick" aria-hidden="true" />
    </span>
  );
}

/** Small chip for anywhere an agent's status appears (roster, board, header): only when paused. */
export function BudgetPausedChip({ status }: { status: Pick<AgentBudgetStatus, "paused" | "reason"> | null | undefined }) {
  if (!status || !status.paused) return null;
  return <HealthChip health="off_track" label="Budget paused" title={status.reason || "Monthly budget reached — paused for new runs"} className="bdg-chip" />;
}

/* ---- panel ------------------------------------------------------------------ */

type Mode = "view" | "edit" | "override";

export function AgentBudgetPanel({ agentId, alias, actorId, denied, projectBudgetHref }: {
  agentId: string;
  alias: string;
  /** href of the project budget controls (Metrics → Monthly budgets); a same-page
   *  default keeps the current ?cid */
  projectBudgetHref?: string;
  /** the acting human (the PUT's actor); null = nobody can act */
  actorId: string | null;
  /** why editing is unavailable (viewer / no grant / no human), or null when allowed */
  denied: string | null;
}) {
  const toast = useToast();
  const [b, setB] = useState<AgentBudget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [usdIn, setUsdIn] = useState("");
  const [tokIn, setTokIn] = useState("");
  const [note, setNote] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const tok = useRef(0);
  const canEdit = !denied && !!actorId;

  const load = () => {
    const my = ++tok.current;
    fetchAgentBudget(agentId)
      .then((d) => {
        if (my !== tok.current) return;
        if (!isAgentBudget(d)) {
          setUnsupported(true);
          return;
        }
        setB(d);
        setError(null);
      })
      .catch((e: Error & { status?: number }) => {
        if (my !== tok.current) return;
        if (e.status === 404 || e.status === 405) setUnsupported(true);
        else setError(e.message);
      });
  };

  useEffect(() => {
    setB(null);
    setError(null);
    setUnsupported(false);
    setMode("view");
    load();
    const iv = setInterval(() => {
      if (!document.hidden) load();
    }, BUDGET_REFRESH_MS);
    return () => {
      clearInterval(iv);
      tok.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const startEdit = () => {
    setUsdIn(b?.limits.usd != null ? String(b.limits.usd) : "");
    setTokIn(b?.limits.tokens != null ? String(b.limits.tokens) : "");
    setFormErr(null);
    setMode("edit");
  };

  const send = (body: BudgetUpdate, ok: string) => {
    if (!canEdit) {
      toast(denied || NO_ACTING_HUMAN, "warn");
      return;
    }
    setBusy(true);
    tok.current++; // a slower in-flight GET must not overwrite the write's answer
    putAgentBudget(agentId, { actor_agent_id: actorId, ...body })
      .then((d) => {
        setB(d);
        setMode("view");
        setNote("");
        toast(ok, "ok");
        announceBudgetChange(); // roster/board chips + Metrics re-read now
      })
      .catch((e: Error) => toast("Budget change failed — " + e.message, "danger"))
      .finally(() => setBusy(false));
  };

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    const usd = parseLimit(usdIn, false);
    const tokens = parseLimit(tokIn, true);
    if (usd === undefined || tokens === undefined) {
      setFormErr("Enter a positive number, or leave blank for no limit.");
      return;
    }
    send({ monthly_limit_usd: usd, monthly_limit_tokens: tokens }, usd == null && tokens == null ? "Budget removed" : "Budget saved");
  };

  const lock = (
    <span className="bdg-lock" tabIndex={0} title={canEdit ? "Only an owner or a member with manage_autonomy can change budgets." : denied || NO_ACTING_HUMAN}>
      <Icon name="shield" cls="v2-ico" />
      {canEdit ? "Human-only" : "Read-only"}
    </span>
  );

  const head = (
    <div className="bdg-h">
      <h3 className="bdg-t">Budget</h3>
      {b ? <span className="bdg-period">{fmtPeriod(b.period)} · resets {fmtReset(b.resets_at)} (UTC)</span> : null}
      <span className="bdg-grow" />
      {/* one verdict chip; when paused the alert card below already says so (D12: no fact twice) */}
      {b && !b.paused ? (() => {
        const h = budgetHealth(b);
        return h ? <HealthChip health={h.health} label={h.label} title={b.reason || h.label} /> : null;
      })() : null}
      {lock}
    </div>
  );

  if (unsupported) return null;
  if (error && !b) {
    return (
      <section className="bdg" aria-label="Budget">
        {head}
        <div className="bdg-card bdg-empty" role="status">
          <span className="bdg-muted">Budget is temporarily unavailable — {error}</span>
          <Button variant="ghost" size="sm" onClick={load}>Retry</Button>
        </div>
      </section>
    );
  }
  if (!b) {
    return (
      <section className="bdg" aria-label="Budget" aria-busy="true">
        {head}
        <div className="bdg-card bdg-empty"><span className="bdg-muted">Loading budget…</span></div>
      </section>
    );
  }

  const u = b.usage;
  const hasLimit = b.limits.usd != null || b.limits.tokens != null;
  const unknownSpend = spendUnknown(u);

  return (
    <section className="bdg" aria-label="Budget" data-state={b.state} data-paused={b.paused ? "true" : "false"}>
      {head}

      {b.paused ? (
        <div className="bdg-alert" role="status" id="bdgPaused">
          <Icon name="alert" cls="v2-ico" />
          <div className="bdg-alert-txt">
            <div className="bdg-alert-t">
              {b.blocked_by === "project" ? "Paused for new runs — project budget reached" : "Paused for new runs"}
            </div>
            <div className="bdg-alert-d">{b.reason}</div>
          </div>
          {canEdit && b.blocked_by === "agent" && mode === "view" ? (
            <span className="bdg-acts">
              <Button size="sm" variant="secondary" onClick={startEdit}>Raise budget</Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("override")}>Override this month</Button>
            </span>
          ) : null}
          {/* KG-5 / B14: the project cap is what's blocking — its controls live on Metrics */}
          {b.blocked_by === "project" && mode === "view" ? (
            <span className="bdg-acts">
              <Link className="v2-btn v2-btn-secondary v2-btn-sm" to={projectBudgetHref || "/metrics#mxBudgets"} id="bdgProjectLink">
                {canEdit ? "Manage project budget" : "View project budget"}
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="bdg-card">
        {!hasLimit && mode !== "edit" ? (
          <div className="bdg-row">
            <div className="bdg-grow">
              <div className="bdg-lbl">No monthly budget</div>
              <div className="bdg-desc">
                {alias} can start runs without a spending limit.{" "}
                {u.runs || u.in_flight_runs ? (
                  <>
                    This month:{" "}
                    {unknownSpend ? <span title={NOT_METERED_TIP}>cost not metered</span> : <span className="tnum">{fmtUsd(u.spend_usd)}</span>}
                    {" · "}
                    <span className="tnum">{fmtTok(u.tokens)}</span> tokens.
                  </>
                ) : (
                  "No runs this month."
                )}
              </div>
            </div>
            {canEdit ? (
              <Button size="sm" variant="secondary" icon="plus" onClick={startEdit} id="bdgSet">
                Set budget
              </Button>
            ) : null}
          </div>
        ) : null}

        {hasLimit && mode !== "edit" ? (
          <>
            <div className="bdg-row">
              <div className="bdg-grow">
                <div className="bdg-lbl">Monthly spend</div>
                <div className="bdg-desc">
                  {b.limits.usd == null ? (
                    <>No dollar limit · {unknownSpend ? "cost not metered" : fmtUsd(u.spend_usd) + " this month"}</>
                  ) : unknownSpend ? (
                    <span title={NOT_METERED_TIP}>Not metered · limit {fmtUsd(b.limits.usd)}</span>
                  ) : (
                    <span className="tnum" id="bdgUsd">
                      {fmtUsd(u.spend_usd)} of {fmtUsd(b.limits.usd)} · {pctLabel(b.usd_ratio)}
                    </span>
                  )}
                </div>
              </div>
              {b.limits.usd != null && !unknownSpend ? <BudgetMeter ratio={b.usd_ratio} label="Monthly spend against budget" /> : null}
            </div>
            <div className="bdg-row">
              <div className="bdg-grow">
                <div className="bdg-lbl">Token cap</div>
                <div className="bdg-desc">
                  {b.limits.tokens == null ? (
                    <>No token cap · <span className="tnum">{fmtTok(u.tokens)}</span> tokens this month</>
                  ) : (
                    <span className="tnum" id="bdgTok">
                      {fmtTok(u.tokens)} of {fmtTok(b.limits.tokens)} tokens · {pctLabel(b.token_ratio)}
                    </span>
                  )}
                </div>
              </div>
              {b.limits.tokens != null ? <BudgetMeter ratio={b.token_ratio} label="Monthly tokens against cap" /> : null}
            </div>
          </>
        ) : null}

        {u.unmetered_runs > 0 && mode !== "edit" ? (
          <div className="bdg-row bdg-note" id="bdgUnmetered">
            <div className="bdg-grow bdg-desc">
              <span className="tnum">{u.unmetered_runs}</span> {u.unmetered_runs === 1 ? "run" : "runs"} ·{" "}
              <span className="tnum">{fmtTok(u.unmetered_tokens)}</span> tokens not metered — not counted as $0
              {b.limits.usd != null && b.limits.tokens == null ? ". The dollar limit can't see these; add a token cap to bound them." : "."}
            </div>
            <HelpTip tip={NOT_METERED_TIP} label="What does not metered mean?" />
          </div>
        ) : null}

        {mode === "edit" ? (
          <form className="bdg-form" onSubmit={onSave} aria-label="Edit budget">
            <label className="bdg-field">
              <span className="bdg-lbl">Monthly limit (USD)</span>
              <span className="bdg-in-wrap">
                <span className="bdg-in-pre" aria-hidden="true">$</span>
                <input className="bdg-in tnum" inputMode="decimal" value={usdIn} placeholder="No limit" aria-label="Monthly limit in US dollars" onChange={(e) => setUsdIn(e.target.value)} autoFocus />
              </span>
            </label>
            <label className="bdg-field">
              <span className="bdg-lbl">Token cap</span>
              <input className="bdg-in tnum" inputMode="numeric" value={tokIn} placeholder="No cap" aria-label="Monthly token cap" onChange={(e) => setTokIn(e.target.value)} />
            </label>
            <p className="bdg-desc bdg-form-note">
              At 80% you get a Needs-you notice. At 100% {alias} is paused for new runs; a run already in progress is not stopped.
            </p>
            {formErr ? <p className="bdg-err" role="alert">{formErr}</p> : null}
            <span className="bdg-acts">
              <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</Button>
              <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
            </span>
          </form>
        ) : null}

        {mode === "override" ? (
          <form
            className="bdg-form"
            aria-label="Grant a one-time override"
            onSubmit={(e) => {
              e.preventDefault();
              send({ override: "grant", note: note.trim() || null }, "Override granted until " + fmtReset(b.resets_at));
            }}
          >
            <p className="bdg-desc bdg-form-note">
              Lets {alias} start new runs for the rest of {fmtPeriod(b.period)} despite the limit. It ends on {fmtReset(b.resets_at)} and is recorded in the audit log.
            </p>
            <input className="bdg-in" value={note} maxLength={500} placeholder="Reason (optional)" aria-label="Override reason" onChange={(e) => setNote(e.target.value)} autoFocus />
            <span className="bdg-acts">
              <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</Button>
              <Button size="sm" variant="primary" type="submit" busy={busy}>Grant override</Button>
            </span>
          </form>
        ) : null}

        {mode === "view" && (b.override.active || u.in_flight_runs > 0 || hasLimit) ? (
          <div className="bdg-foot">
            {b.override.active ? (
              <span className="bdg-ovr" id="bdgOverride" title={b.override.note || undefined}>
                One-time override active until {fmtReset(b.resets_at)}
                {b.override.note ? " · “" + b.override.note + "”" : ""}
              </span>
            ) : null}
            {u.in_flight_runs > 0 ? (
              <span className="bdg-muted" title={IN_FLIGHT_TIP}>
                {u.in_flight_runs} {u.in_flight_runs === 1 ? "run" : "runs"} in progress — not stopped by the budget
              </span>
            ) : null}
            <span className="bdg-grow" />
            {canEdit && b.override.active ? (
              <Button size="sm" variant="ghost" onClick={() => send({ override: "revoke" }, "Override revoked")} disabled={busy}>Revoke override</Button>
            ) : null}
            {canEdit && hasLimit ? (
              <Button size="sm" variant="ghost" icon="sliders" onClick={startEdit} id="bdgEdit">Edit</Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
