import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Button } from "../../components/primitives";

interface Pause { agent_id: string; alias: string; wake_key: string; paused?: boolean }

/** The durable circuit breaker has an explicit, human-only release. */
export function FailurePauses({ cid, humanId, nonce, onResume }: {
  cid: string; humanId: string | null; nonce: number; onResume: () => void;
}) {
  const [rows, setRows] = useState<Pause[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void getJSON<{ backoffs?: Pause[] }>(`/api/containers/${encodeURIComponent(cid)}/wake-backoff`).then(
      (data) => { if (current) { setRows((data.backoffs ?? []).filter((r) => r.wake_key === "run_failure" && r.paused)); setError(""); } },
      () => { if (current) setError("Couldn't check paused agents. Refresh to try again."); },
    );
    return () => { current = false; };
  }, [cid, nonce]);
  async function resume(row: Pause) {
    if (!humanId || busy) return;
    setBusy(row.agent_id);
    setError("");
    try {
      await sendJSON("DELETE", `/api/containers/${encodeURIComponent(cid)}/agents/${encodeURIComponent(row.agent_id)}/wake-backoff/run_failure`, { actor_agent_id: humanId });
      setRows((old) => old.filter((r) => r.agent_id !== row.agent_id));
      onResume();
    } catch {
      setError("Couldn't resume automatic work. Check your connection and permission to manage this project.");
    } finally { setBusy(null); }
  }
  return <>
    {rows.map((row) => <div className="act-warn" role="status" key={row.agent_id}>
      <span>{row.alias}'s automatic work is paused after repeated failures. Check the error below and fix the cause before resuming.</span>
      <Button size="sm" disabled={!humanId || busy !== null} onClick={() => void resume(row)}>
        {busy === row.agent_id ? "Resuming…" : "Resume automatic work"}
      </Button>
    </div>)}
    {error ? <div className="act-warn" role="alert">{error}</div> : null}
  </>;
}
