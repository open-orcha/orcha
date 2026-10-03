/**
 * The org chart's right-side detail panel (click a card). For a person: the
 * manager chain up to the root, direct reports, a "Reports to…" editor (owner /
 * manage_agents; disabled with the reason otherwise), the card facts and
 * "Open agent". For a proposed hire: the full proposal and Approve / Decline
 * (the same decision as Needs you — see orgActions.tsx).
 */
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../components/ui";
import { Avatar, ButtonLink, IconButton } from "../../components/primitives";
import type { Agent, Snapshot } from "../../types";
import { HireActions, type Decide, type HireGate } from "./orgActions";
import {
  directReports, orgStatus, managerCandidates, managerChain, roleLine, spendFact, workSnippet,
  type BudgetsLoad, type OrgAuthority, type OrgForest, type OrgGhost,
} from "./orgModel";
import type { AgentBudgetStatus } from "../agents/budget/budgetModel";
import { BudgetPausedChip } from "../agents/budget/AgentBudgetSection";
import { agentLimitFacts } from "../../lib/agentCap";
import { reviewLoad } from "../../lib/reviewRoute";

export type OrgSel = { kind: "agent"; id: string } | { kind: "hire"; id: string };

export interface PanelEnv {
  snap: Snapshot | null;
  forest: OrgForest;
  auth: OrgAuthority;
  onSet: (agent: Agent, managerId: string | null) => void;
  gate: HireGate;
  onDecide: Decide;
  openTasks: Map<string, number>;
  budgets: Map<string, AgentBudgetStatus>;
  budgetsLoad: BudgetsLoad;
}

function Kind({ a }: { a: Agent }) {
  return <span className={"org-kind" + (a.kind === "human" ? " is-human" : "")}>{a.kind === "human" ? "Human" : "AI"}</span>;
}

function PersonRow({ a, onSelect, sub }: { a: Agent; onSelect: (s: OrgSel) => void; sub?: string }) {
  return (
    <li>
      <button type="button" className="org-p-row" onClick={() => onSelect({ kind: "agent", id: String(a.id) })} data-row={a.alias}>
        <Avatar alias={a.alias} kind={a.kind} ghLogin={a.github_login} status={a.kind === "ai" ? a.status : undefined} size={20} decorative />
        <span className="org-p-row-name">{a.alias}</span>
        <span className="org-p-row-sub">{sub ?? roleLine(a)}</span>
      </button>
    </li>
  );
}

export function OrgPanel({ env, sel, onSelect, onClose }: { env: PanelEnv; sel: OrgSel; onSelect: (s: OrgSel) => void; onClose: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  // focus the panel heading when it opens / switches, so keyboard users land in it
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [sel.kind, sel.id]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest?.(".v2-overlay")) return; // a dialog inside handles its own Escape
    e.preventDefault();
    onClose();
  };
  const agents = env.snap?.agents ?? [];
  const byId = new Map(agents.map((a) => [String(a.id), a]));

  let body: React.ReactNode = null;
  let label = "Details";
  if (sel.kind === "hire") {
    const g: OrgGhost | undefined = env.forest.ghosts.find((x) => x.requestId === sel.id);
    if (!g) return null;
    label = `Proposed hire ${g.alias}`;
    body = (
      <>
        <header className="org-p-h">
          <Avatar alias={g.alias} kind="ai" size={32} decorative />
          <div className="org-p-h-t">
            <h2 className="org-p-name" ref={titleRef} tabIndex={-1}>{g.alias}</h2>
            <div className="org-p-meta"><span className="org-kind is-proposed">Proposed hire</span></div>
          </div>
          <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />
        </header>
        <section className="org-p-sec" aria-label="Proposal">
          <div className="org-p-lbl">Role</div>
          <p className="org-p-text">{g.role || "No role given"}</p>
          <div className="org-p-lbl">Why</div>
          <p className="org-p-text">{g.rationale || "No rationale given"}</p>
          {g.prompt ? (
            <details className="org-p-details">
              <summary>Proposed instructions</summary>
              <p className="org-p-text is-pre">{g.prompt}</p>
            </details>
          ) : null}
          <div className="org-p-by">Suggested by {g.proposedBy}{g.waitingOn ? <> · waiting on {g.waitingOn}</> : null}</div>
        </section>
        <section className="org-p-sec org-p-decide" aria-label="Decision">
          <div className="org-p-help">A human decides — agents never create agents.</div>
          <HireActions g={g} gate={env.gate} onDecide={env.onDecide} limit={agentLimitFacts(env.snap)} size="md" />
          {env.gate.approve || env.gate.decline ? <div className="org-p-why">{env.gate.approve || env.gate.decline}</div> : null}
          <Link className="org-p-link" to={g.href}>Open in Needs you <Icon name="arrow" cls="org-inline-ico" /></Link>
        </section>
      </>
    );
  } else {
    const a = byId.get(sel.id);
    if (!a) return null;
    const id = String(a.id);
    label = `${a.alias} details`;
    const chain = managerChain(env.forest, byId, id);
    const reports = directReports(env.snap, env.forest, id);
    const current = env.forest.managerOf.get(id) ?? "";
    const cands = managerCandidates(env.snap, env.forest, id);
    const snippet = workSnippet(a, env.snap);
    const st = orgStatus(a, env.snap);
    const open = env.openTasks.get(a.alias) ?? 0;
    const spend = a.kind === "ai" ? spendFact(env.budgets.get(id), env.budgetsLoad) : null;
    const gone = env.forest.managerGone.has(id);
    const rv = reviewLoad(env.snap, id);
    const selectId = "org-p-mgr-" + id;
    body = (
      <>
        <header className="org-p-h">
          <Avatar alias={a.alias} kind={a.kind} ghLogin={a.github_login} status={a.kind === "ai" ? a.status : undefined} size={32} decorative />
          <div className="org-p-h-t">
            <h2 className="org-p-name" ref={titleRef} tabIndex={-1}>{a.alias}</h2>
            <div className="org-p-meta"><Kind a={a} /><span className="org-p-role">{roleLine(a)}</span></div>
          </div>
          <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />
        </header>

        <section className="org-p-sec" aria-label="Status">
          <div className={"org-p-status s-" + st.cls} title={st.title}>
            <span className="org-dot" aria-hidden="true" />{st.text}
            <BudgetPausedChip status={a.kind === "ai" ? env.budgets.get(id) : undefined} />
          </div>
          {snippet ? <p className="org-p-text">{snippet}</p> : null}
          <dl className="org-p-facts">
            <div><dt>Open tasks</dt><dd>{open}</dd></div>
            <div><dt>Reports</dt><dd>{reports.length}</dd></div>
            {rv.covers.length ? <div><dt>Reviews for</dt><dd title={rv.covers.map((c) => c.alias).join(", ")}>{rv.covers.length}</dd></div> : null}
            {spend ? <div><dt>This month</dt><dd className={"org-spend is-" + spend.tone} title={spend.title}>{spend.text}</dd></div> : null}
          </dl>
        </section>

        <section className="org-p-sec" aria-label="Manager chain">
          <div className="org-p-lbl">Manager chain</div>
          {chain.length ? (
            <ol className="org-p-crumbs">
              {chain.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => onSelect({ kind: "agent", id: String(m.id) })}>{m.alias}</button>
                  <span aria-hidden="true">›</span>
                </li>
              ))}
              <li aria-current="true"><span>{a.alias}</span></li>
            </ol>
          ) : <p className="org-p-muted">{gone ? "Manager retired — no active manager" : "No manager — top of the chart"}</p>}
        </section>

        <section className="org-p-sec" aria-label="Change manager">
          <label className="org-p-lbl" htmlFor={selectId}>Reports to</label>
          <select
            id={selectId} className="org-p-select" value={current} disabled={!env.auth.can}
            title={env.auth.can ? undefined : env.auth.reason || undefined}
            onChange={(e) => { const v = e.target.value || null; if ((current || null) !== v) env.onSet(a, v); }}
          >
            <option value="">No manager</option>
            {cands.map((m) => <option key={m.id} value={String(m.id)}>{m.alias} — {m.kind === "human" ? "Human" : roleLine(m)}</option>)}
          </select>
          {!env.auth.can && env.auth.reason ? <div className="org-p-why">{env.auth.reason}</div> : null}
        </section>

        {rv.covers.length || rv.pending.length ? (
          <section className="org-p-sec" aria-label="Reviews" data-testid="org-p-reviews">
            <div className="org-p-lbl">Reviews <span className="org-lane-count">{rv.pending.length}</span></div>
            {rv.covers.length ? (
              <p className="org-p-muted">
                {a.kind === "human" ? "Verifies" : "Pre-reviews"} finished work from {rv.covers.map((c) => c.alias).join(", ")}.
              </p>
            ) : null}
            {rv.pending.length ? (
              <ul className="org-p-list">
                {rv.pending.map((t) => (
                  <li key={t.id}>
                    <Link className="org-p-row" to={"/tasks?task=" + encodeURIComponent(t.id)} data-review-task={t.id} title={t.title}>
                      <Icon name="check" cls="org-inline-ico" />
                      <span className="org-p-row-name">{t.title}</span>
                      <span className="org-p-row-sub">{t.assignee ? "from " + t.assignee : ""}{t.manager_review?.status === "approved" ? " · " + (t.manager_review.manager_alias || "manager") + " recommends approval" : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="org-p-muted">Nothing waiting on {a.alias} right now.</p>}
          </section>
        ) : null}

        <section className="org-p-sec" aria-label="Direct reports">
          <div className="org-p-lbl">Direct reports <span className="org-lane-count">{reports.length}</span></div>
          {reports.length ? (
            <ul className="org-p-list">{reports.map((r) => <PersonRow key={r.id} a={r} onSelect={onSelect} />)}</ul>
          ) : <p className="org-p-muted">No one reports to {a.alias}.</p>}
        </section>

        {a.kind === "ai" ? (
          <div className="org-p-foot">
            <ButtonLink to={"/agents?agent=" + encodeURIComponent(a.alias)} variant="secondary" size="sm" iconRight="arrow">Open agent</ButtonLink>
          </div>
        ) : null}
      </>
    );
  }
  return (
    <aside className="org-panel" ref={ref} aria-label={label} data-testid="org-panel" onKeyDown={onKeyDown}>
      {body}
    </aside>
  );
}
