import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives/Button";
import { checkWorkflowOperation, sendWorkflowOperation, useWorkflowOperation } from "./workflowOperations";
import type { DraftScope } from "./workflowDraft";
import type { WorkflowDetail } from "./workflowContract.generated";

export function WorkflowOperationNotice({ scope, slot, canRetry, onSaved }: {
  scope: DraftScope; slot: string; canRetry: () => Promise<boolean>; onSaved: (result: WorkflowDetail) => void;
}) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const operation = useWorkflowOperation(scope, slot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!operation || operation.state === "saved") return null;
  async function recover(replay: boolean) {
    if (busy || !operation) return;
    setBusy(true); setError("");
    try {
      // Always look up the receipt before replay. A missing receipt is not a
      // failure verdict; replay reuses the exact key/body under server locking.
      let result = await checkWorkflowOperation(scope, slot);
      if (replay && result?.state === "uncertain") {
        if (!await canRetry()) { setError("Access changed. The original request is kept; you can still check its saved result."); return; }
        if (!active.current) return;
        result = await sendWorkflowOperation(scope, slot, operation, true);
      }
      if (active.current && result?.state === "saved" && result.result) onSaved(result.result);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check the saved result."); }
    finally { setBusy(false); }
  }
  return <section className={`wf-opnotice ${operation.state === "refused" ? "is-danger" : "is-warn"}`} role={operation.state === "refused" ? "alert" : "status"} aria-label="Save status" aria-live="polite">
    <p>{operation.state === "sending" ? "Saving… Keep this page open while Orcha confirms the result." : operation.message}</p>
    {error && <p role="alert">{error}</p>}
    {operation.state === "uncertain" && <div className="wf-actions">
      <Button disabled={busy} onClick={() => void recover(false)}>Check saved result</Button>
      <Button disabled={busy} onClick={() => void recover(true)}>Retry same request</Button>
    </div>}
  </section>;
}
