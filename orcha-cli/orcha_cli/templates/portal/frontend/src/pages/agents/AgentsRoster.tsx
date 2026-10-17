/**
 * Agents roster — the compact list view (D9 "toggle to the compact roster
 * list view"). Linear list: band group headers (AI agents / Humans, each
 * collapsible), one 40 px row per actor: round avatar (presence dot, page-wide
 * palette slot — D13) · alias over ONE muted meta line (the task it is on, with
 * the task's status glyph, else the role — r3: one rule for every row) · ONE
 * muted status word, only when not idle. The status is told once
 * (R1): the embodiment lease ("in convo", "live", "task") lives in the status
 * word's tooltip and the row tooltip, never as a second word on the row; an
 * idle agent that still holds a lease (backgrounded terminal) shows the lease
 * badge in the status slot instead.
 */
import type { MutableRefObject } from "react";
import type { Agent } from "../../types";
import { List, Row } from "../../components/primitives/List";
import { Avatar, StatusIcon, actorKey, rosterPaletteSlots } from "../../components/primitives";
import { pendingPlan, useSnapshot } from "../../state/SnapshotProvider";
import { ListGroup } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { leaseOf } from "../../lib/status";
import { EMBOD_LBL, EMBOD_TITLE, EmbodBadge, activityOf, agentPresenceWord, onTask } from "./agentModel";
import { BudgetPausedChip } from "./budget/AgentBudgetSection";
import type { AgentBudgetStatus } from "./budget/budgetModel";

/** The roster filter — rendered in the page toolbar row (left), not above the list. */
export function RosterSearch({ q, onQ }: { q: string; onQ: (q: string) => void }) {
  return (
    <label className="roster-search">
      <Icon name="search" cls="v2-ico" />
      <input className="roster-filter" type="search" placeholder="Filter agents" aria-label="Filter agents" value={q} onChange={(e) => onQ(e.target.value)} />
    </label>
  );
}

export function AgentsRoster({ agents, selAlias, onSelect, rosterRef, q, onQ, search = true, paused }: {
  agents: Agent[];
  selAlias: string | null;
  onSelect: (alias: string) => void;
  rosterRef: MutableRefObject<HTMLElement | null>;
  q: string;
  onQ: (q: string) => void;
  /** false when the page renders <RosterSearch> in its toolbar row */
  search?: boolean;
  /** KG-6/B25: budget-paused agents by id (pausedById) — the row says so */
  paused?: Record<string, AgentBudgetStatus>;
}) {
  const { snap } = useSnapshot();
  const fq = q.trim().toLowerCase();
  const match = (x: Agent) => !fq || x.alias.toLowerCase().includes(fq) || (x.role || "").toLowerCase().includes(fq);
  const ai = agents.filter((x) => x.kind !== "human");
  const humans = agents.filter((x) => x.kind === "human");
  // D13: the project roster's ONE slot map (same as the sidebar / board / popovers)
  const slots = rosterPaletteSlots(snap?.agents?.length ? snap.agents : agents) ?? new Map<string, number>();

  const row = (ag: Agent) => {
    const act = activityOf(ag);
    // r3: ONE sub-line rule — the task it is on (its status glyph) when there is one, else the role
    const cur = ag.kind === "human" ? null : onTask(ag);
    // the task's OWN glyph (the shared status set) — in progress unless the snapshot says otherwise
    const curTask = cur ? (snap?.tasks ?? []).find((t) => t.id === cur.id) : null;
    const curGlyph = curTask ? (pendingPlan(curTask) ? "awaiting_human" : curTask.status) : "in_progress";
    const lease = leaseOf(ag);
    const leaseTxt = lease && lease !== "idle" ? EMBOD_LBL[lease] || lease : "";
    const human = ag.kind === "human";
    // one presence function on every surface (presence.ts agentPresence)
    const pres = human ? null : agentPresenceWord(ag, snap);
    const word = pres ? pres.label : null;
    const tip = [ag.alias, ag.role, human ? "" : word || "Idle", act ? "Now: " + act : "", leaseTxt ? "Lease: " + leaseTxt : ""].filter(Boolean).join("\n");
    const wordTip = [pres ? pres.reason : "", leaseTxt ? EMBOD_TITLE[lease] || leaseTxt : ""].filter(Boolean).join(" — ");
    const sel = ag.alias === selAlias;
    const stop = human ? null : paused?.[ag.id] ?? null;
    return (
      <Row key={ag.id} id={ag.alias} selected={sel} className={"rrow" + (sel ? " sel" : "")} onActivate={() => onSelect(ag.alias)}>
        <span className="rrow-in" data-alias={ag.alias} title={tip}>
          <Avatar alias={ag.alias} kind={ag.kind} size={32} ghLogin={ag.github_login} status={human ? null : ag.status} palette={slots.get(actorKey(ag.alias))} decorative />
          <span className="grow">
            <span className="nm">{ag.alias}</span>
            {stop ? (
              // KG-6/B25: the budget stop leads the sub-line — why its queued work stalls
              // (the reason is the chip's tooltip); the name keeps the full first line
              <span className="rl rl-task rl-budget">
                <BudgetPausedChip status={stop} />
                <span className="rl-t">{cur ? cur.title : ag.role || ""}</span>
              </span>
            ) : cur ? (
              <span className="rl rl-task">
                <StatusIcon status={curGlyph} size={12} decorative />
                <span className="rl-t">{cur.title}</span>
              </span>
            ) : (
              <span className="rl">{ag.role || <span className="rl-none">No role</span>}</span>
            )}
          </span>
          {word ? (
            <span className="rstat rword" data-status={ag.status} data-presence={pres?.k} data-lease={leaseTxt ? lease : undefined} title={wordTip}>
              {word}
            </span>
          ) : leaseTxt ? (
            // idle status but a held lease (e.g. a backgrounded live terminal,
            // ISS-71): the lease is the one fact worth showing, so it stays findable
            <EmbodBadge a={ag} />
          ) : (
            <span className="v2-sr">{human ? "Human" : "Idle"}</span>
          )}
        </span>
      </Row>
    );
  };

  return (
    <aside className="roster-card" id="roster" ref={rosterRef} aria-label="Agent roster">
      {/* the band headers carry the visible counts; the total stays for screen readers */}
      <div className="rh v2-sr">
        <span>Roster · {agents.length}</span>
      </div>
      {search && agents.length > 8 ? <RosterSearch q={q} onQ={onQ} /> : null}
      {ai.length ? (
        <ListGroup id="ai" storageKey="orcha:v2:agentsRoster" title="AI agents" count={ai.length} level={3}>
          <List label="AI agents">{ai.filter(match).map(row)}</List>
        </ListGroup>
      ) : null}
      {humans.length ? (
        <ListGroup id="human" storageKey="orcha:v2:agentsRoster" title="Humans" count={humans.length} level={3}>
          <List label="Humans">{humans.filter(match).map(row)}</List>
        </ListGroup>
      ) : null}
      {fq && ![...ai, ...humans].some(match) ? <div className="none">No agents match “{q}”.</div> : null}
    </aside>
  );
}
