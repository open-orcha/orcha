/**
 * Settings → Execution › Agent limit (mig 056): how many agents created from
 * suggestions this project may hold (containers.max_auto_agents, 1-50).
 *
 * Reads the snapshot container (max_auto_agents + auto_agents_in_use); writes
 * PUT /api/containers/{cid}/limits {max_auto_agents, actor_agent_id}. The server
 * gate is owner-or-manage_agents (the same as creating the agent it unblocks);
 * without it — viewers included — the stepper is disabled and says why.
 */
import { useEffect, useState } from "react";
import { sendJSON } from "../../api/client";
import { useToast } from "../../components/ui";
import { Button, Tooltip } from "../../components/primitives";
import { AGENT_LIMIT_MAX, AGENT_LIMIT_MIN } from "../../lib/agentCap";
import { useSnapshot } from "../../state/SnapshotProvider";
import { useGrantAuthority } from "./grantAuthority";
import { SettingRow, settingsErrText } from "./settingsUi";

const clamp = (n: number) => Math.min(AGENT_LIMIT_MAX, Math.max(AGENT_LIMIT_MIN, Math.round(n)));

/** The row's description line (pure, tested). */
export function agentLimitDesc(inUse: number | null | undefined): string {
  return "Suggested agents that can be created in this project" + (inUse != null ? ` — ${inUse} in use` : "");
}

export function AgentLimitRow({ cid }: { cid: string | null }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const auth = useGrantAuthority("manage_agents");
  const persisted = snap?.container?.max_auto_agents;
  const inUse = snap?.container?.auto_agents_in_use;
  const [draft, setDraft] = useState<string>(persisted != null ? String(persisted) : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (persisted != null) setDraft(String(persisted)); }, [persisted]);

  // an old backend that doesn't send the limit: nothing honest to show
  if (persisted == null) return null;

  const locked = !auth.can;
  const n = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(n) && n >= AGENT_LIMIT_MIN && n <= AGENT_LIMIT_MAX;
  const dirty = valid && n !== persisted;
  const step = (d: number) => setDraft(String(clamp((Number.isFinite(n) && draft.trim() !== "" ? n : persisted) + d)));

  const save = async () => {
    if (!cid || !dirty || busy || locked || !auth.human) return;
    setBusy(true);
    try {
      await sendJSON("PUT", "/api/containers/" + encodeURIComponent(cid) + "/limits", {
        max_auto_agents: n,
        actor_agent_id: auth.human.id,
      });
      await refresh();
      toast(`Agent limit set to ${n}.`, "ok");
    } catch (e) {
      toast("Couldn't change the agent limit — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const control = (
    <div className="set-agent-limit">
      <Button size="sm" variant="secondary" aria-label="Decrease agent limit" disabled={locked || busy || (valid && n <= AGENT_LIMIT_MIN)} onClick={() => step(-1)}>−</Button>
      <input
        id="setAgentLimit"
        className="set-agent-limit-n"
        type="number"
        inputMode="numeric"
        min={AGENT_LIMIT_MIN}
        max={AGENT_LIMIT_MAX}
        step={1}
        value={draft}
        aria-labelledby="setAgentLimitL"
        aria-describedby="setAgentLimitD"
        aria-invalid={!valid || undefined}
        disabled={locked || busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
      />
      <Button size="sm" variant="secondary" aria-label="Increase agent limit" disabled={locked || busy || (valid && n >= AGENT_LIMIT_MAX)} onClick={() => step(1)}>+</Button>
      {dirty && !locked ? <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>Save</Button> : null}
    </div>
  );

  return (
    <SettingRow
      label="Agent limit"
      id="setAgentLimitL"
      desc={
        <span id="setAgentLimitD">
          {agentLimitDesc(inUse)}
          {!valid ? ` · Enter a whole number from ${AGENT_LIMIT_MIN} to ${AGENT_LIMIT_MAX}.` : ""}
          {locked && auth.reason && !auth.pending ? <> · <span data-testid="agent-limit-reason">{auth.reason}</span></> : null}
        </span>
      }
    >
      {locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{control}</Tooltip> : control}
    </SettingRow>
  );
}
