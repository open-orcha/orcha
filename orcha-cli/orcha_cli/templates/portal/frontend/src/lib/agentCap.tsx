/**
 * The project's agent limit (containers.max_auto_agents, mig 056) as the UI says it.
 *
 * Approving a proposed agent (POST /api/agent-suggestions/{rid}/decide, kind "create")
 * is refused with a 409 once the project already holds its limit of agents created
 * from suggestions. Every caller (Needs you / Requests, Org chart card + panel) shows
 * the SAME plain sentence — never the raw "<path> → 409" error — and, for people who
 * can change the limit, a way to Settings → Execution where it lives.
 */
import { ButtonLink } from "../components/primitives";

export const AGENT_LIMIT_MIN = 1;
export const AGENT_LIMIT_MAX = 50;
export const AGENT_LIMIT_SETTINGS_HREF = "/settings#tab=execution";

export interface AgentCap {
  /** the project's limit (max_auto_agents) */
  limit: number;
  /** live agents already created from suggestions */
  inUse: number;
}

/**
 * The cap facts from a failed decide call, or null when it is not the cap 409.
 * Reads the server's detail: "this project already has 3 suggested agents (the limit
 * is 3)…" (and the older "container is at the 3-agent cap"). `fallback` fills what
 * the message leaves out (the snapshot's max_auto_agents / auto_agents_in_use).
 */
export function agentCapOf(e: unknown, fallback?: { limit?: number | null; inUse?: number | null }): AgentCap | null {
  const err = e as { status?: number; detail?: string; message?: string } | null;
  if (!err || err.status !== 409) return null;
  const text = err.detail || err.message || "";
  const cur = /already has (\d+) suggested agents?\b[^(]*\(the limit is (\d+)\)/i.exec(text);
  if (cur) return { inUse: Number(cur[1]), limit: Number(cur[2]) };
  const old = /at the (\d+)-agent cap/i.exec(text);
  if (old) {
    const limit = Number(old[1]);
    return { limit, inUse: Math.max(limit, fallback?.inUse ?? limit) };
  }
  return null;
}

/** The snapshot's limit facts (fallback for agentCapOf). */
export function agentLimitFacts(snap: { container?: { max_auto_agents?: number; auto_agents_in_use?: number } | null } | null | undefined): { limit?: number; inUse?: number } {
  const c = snap?.container;
  return { limit: c?.max_auto_agents, inUse: c?.auto_agents_in_use };
}

const agents = (n: number) => n + " suggested agent" + (n === 1 ? "" : "s");

/** The one sentence every decide caller shows at the cap. */
export function agentCapMessage(c: AgentCap): string {
  return (
    `This project allows up to ${agents(c.limit)} and already has ${c.inUse}. ` +
    "Raise the limit in Settings → Execution, or reassign this work to an existing agent."
  );
}

/** The cap notice inside a decide dialog: the sentence, plus the way to the limit for
 *  people who can change it (owner / manage_agents). Retry stays the dialog's own
 *  confirm button. */
export function AgentCapNotice({ cap, canRaise }: { cap: AgentCap; canRaise: boolean }) {
  return (
    <div className="wk-err agent-cap-note" role="alert">
      <b>Not decided.</b> {agentCapMessage(cap)}
      {canRaise ? (
        <div style={{ marginTop: 8 }}>
          <ButtonLink size="sm" variant="secondary" icon="settings" to={AGENT_LIMIT_SETTINGS_HREF}>
            Open Settings → Execution
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}
