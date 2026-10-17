/**
 * Org chart actions that need a human's confirmation:
 *
 *  - HireActions — Approve / Decline ON a proposed-hire card (and in the detail
 *    panel). It is the SAME decision Needs you makes (RequestsPage
 *    SuggestionDecision): POST /api/agent-suggestions/{rid}/decide with
 *    kind "create" (approve) or "refuse" (decline) and the acting human as
 *    actor_agent_id, behind the same confirm copy. The server enforces the
 *    grant; the gate here (see hireGate) only disables the affordance and says
 *    why. Agents never create agents — only this human decision does.
 *
 *  - SetupSuggestion — the empty state's one-click "Everyone reports to <owner>":
 *    a confirm dialog listing every change; nothing is written until the human
 *    confirms, then each line is its own authorized PUT /api/agents/{aid}/reports-to.
 */
import { useState } from "react";
import { Avatar, Button, Dialog } from "../../components/primitives";
import type { ActingAuthority } from "../../state/SnapshotProvider";
import type { Identity } from "../../extensions";
import type { Snapshot } from "../../types";
import { grantDenied } from "../agents/agentModel";
import { noHumanReqReason, suggestionFailMsg } from "../requests/RequestsPage";
import { AgentCapNotice, agentCapOf, type AgentCap } from "../../lib/agentCap";
import type { OrgAuthority, OrgGhost, OrgSuggestion } from "./orgModel";

/** Why Approve / Decline are unavailable (null = allowed). */
export interface HireGate {
  approve: string | null;
  decline: string | null;
}

/** Same gate as Needs you: approving creates an agent (owner or manage_agents);
 *  declining needs any acting human. Viewers / nobody-acting get the reason. */
export function hireGate(snap: Snapshot | null, identity: Identity | null, authority: ActingAuthority): HireGate {
  const noHuman = noHumanReqReason(authority);
  const h = authority.human;
  return {
    approve: grantDenied(snap, identity, "manage_agents", noHuman) ?? (h ? null : noHuman),
    decline: h ? null : noHuman,
  };
}

/** A gate derived from the org authority alone (component tests / fallbacks). */
export function hireGateFromAuth(auth: OrgAuthority): HireGate {
  const r = auth.reason || "You can't decide proposed hires";
  return { approve: auth.can ? null : r, decline: auth.human ? null : r };
}

export type HireDecision = "create" | "refuse";
export type Decide = (g: OrgGhost, kind: HireDecision, reason?: string) => Promise<void>;

export function HireActions({ g, gate, onDecide, size = "sm", limit }: {
  g: OrgGhost; gate: HireGate; onDecide: Decide; size?: "sm" | "md";
  /** the snapshot's agent limit facts — fill what the cap 409 leaves out */
  limit?: { limit?: number | null; inUse?: number | null };
}) {
  const [mode, setMode] = useState<HireDecision | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the project's agent limit refused the approval — the cap notice, never the raw error
  const [cap, setCap] = useState<AgentCap | null>(null);
  const open = (m: HireDecision) => { setError(null); setReason(""); setMode(m); };
  const go = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      await onDecide(g, mode, mode === "refuse" ? reason.trim() || undefined : undefined);
      setMode(null);
    } catch (e) {
      setCap(mode === "create" ? agentCapOf(e, limit) : null);
      setError(suggestionFailMsg(e, mode));
    } finally {
      setBusy(false);
    }
  };
  // clicks inside the card's buttons must not also select the card / pan the canvas
  const stop = { onClick: (e: React.MouseEvent) => e.stopPropagation(), onPointerDown: (e: React.PointerEvent) => e.stopPropagation() };
  return (
    <div className="org-hire-acts" {...stop}>
      <Button
        size={size} variant="secondary" disabled={!!gate.decline} title={gate.decline ?? `Decline ${g.alias}`}
        data-denied={gate.decline ?? undefined} aria-label={`Decline ${g.alias}`} onClick={() => open("refuse")}
      >Decline</Button>
      <Button
        size={size} variant="primary" disabled={!!gate.approve} title={gate.approve ?? `Approve — create ${g.alias}`}
        data-denied={gate.approve ?? undefined} aria-label={`Approve ${g.alias}`} onClick={() => open("create")}
      >Approve</Button>
      {mode ? (
        <Dialog
          title={mode === "create" ? `Create agent “${g.alias}”?` : "Refuse this suggestion?"}
          description={mode === "create"
            ? "Creates the proposed agent with the role and instructions above, then routes this request to it. The project's agent cap still applies."
            : "Closes the request; the requester sees it refused."}
          onClose={() => { if (!busy) setMode(null); }}
          size="sm"
          footer={(
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
              <Button variant={mode === "refuse" ? "danger" : "primary"} busy={busy} onClick={() => void go()}>
                {error && cap ? "Retry" : mode === "create" ? "Create agent" : "Refuse"}
              </Button>
            </>
          )}
        >
          {mode === "refuse" ? (
            <textarea className="ans-in" aria-label="Reason (optional)" placeholder="Reason (optional)…" value={reason} onChange={(e) => setReason(e.target.value)} />
          ) : (
            <div className="org-dlg-hire">
              <Avatar alias={g.alias} kind="ai" size={24} decorative />
              <div><b>{g.alias}</b>{g.role ? <div className="org-dlg-muted">{g.role}</div> : null}</div>
            </div>
          )}
          {/* approving already needs owner / manage_agents — the same gate as the limit */}
          {error && cap ? <AgentCapNotice cap={cap} canRaise={!gate.approve} /> : error ? <div className="wk-err" role="alert"><b>Not decided.</b> {error}</div> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

/* ---- "Everyone reports to <owner>" ------------------------------------------------ */

export type ApplySuggestion = (s: OrgSuggestion) => Promise<{ ok: number; failed: { alias: string; message: string }[] }>;

export function SetupSuggestion({ s, auth, onApply, compact }: { s: OrgSuggestion; auth: OrgAuthority; onApply: ApplySuggestion; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ alias: string; message: string }[]>([]);
  const denied = auth.can ? null : auth.reason || "You can't change reporting lines";
  const go = async () => {
    setBusy(true);
    try {
      const r = await onApply(s);
      if (r.failed.length) setFailed(r.failed);
      else setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const n = s.changes.length;
  return (
    <div className={"org-setup" + (compact ? " is-compact" : "")} role="region" aria-label="Set up reporting lines">
      <div className="org-setup-text">
        <div className="org-setup-t">No reporting lines yet</div>
        <div className="org-setup-d">
          People who receive escalations are shown on top. Dashed lines are a preview — nothing is saved until you confirm.
        </div>
        {denied ? <div className="org-setup-why">{denied}</div> : null}
      </div>
      <Button
        size="sm" variant="primary" disabled={!!denied} title={denied ?? undefined} data-denied={denied ?? undefined}
        onClick={() => { setFailed([]); setOpen(true); }}
      >Everyone reports to {s.owner.alias}…</Button>
      {open ? (
        <Dialog
          title={`Everyone reports to ${s.owner.alias}?`}
          description={`${n} ${n === 1 ? "agent" : "agents"} will report to ${s.owner.alias}. Their untargeted asks and escalations then go to ${s.owner.alias} first. You can change any line later.`}
          onClose={() => { if (!busy) setOpen(false); }}
          size="sm"
          footer={(
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void go()}>
                {failed.length ? "Retry" : `Apply ${n} ${n === 1 ? "change" : "changes"}`}
              </Button>
            </>
          )}
        >
          <ul className="org-setup-list" aria-label="Changes">
            {s.changes.map((a) => {
              const f = failed.find((x) => x.alias === a.alias);
              return (
                <li key={a.id} data-change={a.alias}>
                  <Avatar alias={a.alias} kind="ai" ghLogin={a.github_login} size={20} decorative />
                  <span className="org-setup-who">{a.alias}</span>
                  <span className="org-setup-arrow" aria-hidden="true">→</span>
                  <span className="org-setup-arrow-sr">reports to</span>
                  <Avatar alias={s.owner.alias} kind="human" ghLogin={s.owner.github_login} size={20} decorative />
                  <span className="org-setup-who">{s.owner.alias}</span>
                  {f ? <span className="org-setup-fail" role="alert">{f.message}</span> : null}
                </li>
              );
            })}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}
