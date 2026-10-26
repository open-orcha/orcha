import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Button } from "../../components/primitives";

interface Pause { agent_id: string; alias: string; wake_key: string; paused?: boolean; notice_request_id?: string | null }

/** On a repeated-failure pause notice: answering or nudging does not restart work, so the
 *  explicit human Resume lives here. The server decides which notice owns the pause. */
export function PauseNoticeResume({ cid, requestId, humanId, onResumed }: {
  cid: string | undefined; requestId: string; humanId: string | null; onResumed: () => void;
}) {
  const [pause, setPause] = useState<Pause | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!cid) return;
    let current = true;
    void getJSON<{ backoffs?: Pause[] }>(`/api/containers/${encodeURIComponent(cid)}/wake-backoff`).then(
      (data) => {
        if (current) setPause((data.backoffs ?? []).find((r) => r.paused && r.notice_request_id === requestId) ?? null);
      },
      () => { if (current) setPause(null); },
    );
    return () => { current = false; };
  }, [cid, requestId]);
  if (!pause) return null;
  async function resume() {
    if (!humanId || busy) return;
    setBusy(true);
    setError("");
    try {
      await sendJSON("POST", `/api/requests/${encodeURIComponent(requestId)}/resume-automatic-work`, { actor_agent_id: humanId });
      setPause(null);
      onResumed();
    } catch {
      setError("Couldn't resume automatic work. Check your connection and permission to manage this project.");
    } finally { setBusy(false); }
  }
  return (
    <div className="rq-pause" role="status">
      <span>{pause.alias}'s automatic work is still paused. Answering or nudging won't restart it — fix the cause, then resume.</span>
      <Button size="sm" disabled={!humanId || busy} onClick={() => void resume()}>
        {busy ? "Resuming…" : "Resume automatic work"}
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
