/**
 * The one clear state when a run could not start: no agent, or the QA tools off. Add a QA agent
 * creates the agent, turns the tools on, and gives it the task already waiting, if there is one.
 */
import { useState } from "react";
import { Button, MenuButton } from "../../../components/primitives";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { QaAuthority } from "../authority";
import { errText } from "../parts";
import { addQaAgent, assignTask, enableQaTools, setupMissing, type QaSetup } from "./setup";

export function SetupGate({ cid, auth, setup, waitingTask, onDone }: {
  cid: string; auth: QaAuthority; setup: QaSetup;
  /** A task sitting with no assignee: picking or adding an agent gives it to them. */
  waitingTask?: string | null;
  onDone: (agentId?: string) => void;
}) {
  const { snap, refresh } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const missing = setupMissing(setup);
  const agents = (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated");
  const actor = auth.human?.id ?? null;
  const act = async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    setErr(null);
    try {
      const id = await work();
      await refresh?.();
      onDone(id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const addAgent = () => act(async () => {
    const { agent_id } = await addQaAgent(cid);
    if (!setup.tools_on && setup.can_enable) await enableQaTools(cid, actor);
    if (waitingTask) await assignTask(waitingTask, agent_id, actor);
    return agent_id;
  });
  const pick = (id: string) => act(async () => { await assignTask(waitingTask!, id, actor); return id; });
  const turnOn = () => act(async () => { await enableQaTools(cid, actor); return undefined; });

  if (missing === "agent") {
    return (
      <section className="qa-setup" data-qa-setup="agent">
        <h2 className="qa-setup-t">This project has no agent to run checks</h2>
        <div className="qa-actions">
          <Button variant="primary" busy={busy} disabled={!auth.can} onClick={() => void addAgent()} data-add-qa-agent>Add a QA agent</Button>
        </div>
        {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
        {err ? <p className="qa-error" role="alert">{err}</p> : null}
      </section>
    );
  }
  if (missing === "tools") {
    return (
      <section className="qa-setup" data-qa-setup="tools">
        <h2 className="qa-setup-t">QA tools are off for this project</h2>
        <div className="qa-actions">
          <Button variant="primary" busy={busy} disabled={!auth.can} onClick={() => void turnOn()} data-enable-qa-tools>Turn them on</Button>
        </div>
        {!auth.can ? <p className="qa-muted qa-gate">{auth.reason}</p> : null}
        {err ? <p className="qa-error" role="alert">{err}</p> : null}
      </section>
    );
  }
  if (waitingTask) {
    return (
      <section className="qa-setup" data-qa-setup="waiting">
        <h2 className="qa-setup-t">This run has no agent yet</h2>
        <div className="qa-actions">
          <MenuButton menuLabel="Agent for this run" size="sm" disabled={!auth.can || busy} value="Pick an agent" items={agents.map((a) => ({ label: a.alias, hint: a.role || undefined, onSelect: () => void pick(a.id) }))} />
        </div>
        {err ? <p className="qa-error" role="alert">{err}</p> : null}
      </section>
    );
  }
  return null;
}
