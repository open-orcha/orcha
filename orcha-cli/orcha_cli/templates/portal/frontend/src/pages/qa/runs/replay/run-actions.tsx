import { useState } from "react";
import { RotateCw, Square } from "../../map/kit/icons";
import { Tooltip } from "../../../../components/primitives";
import { Button, useConfirm, useToast } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { stopSession } from "../../sessions/api";

const STOP_CONFIRM_MESSAGE = "What it has found so far is kept.";

/** Stop, for a person: ends the running session (`PATCH /api/qa/sessions/{id}`). */
export function StopRunButton({ runId, auth, onStopped }: { runId: string; auth: QaAuthority; onStopped: () => void }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);

  async function stop() {
    const ok = await confirm({
      title: "Stop this run?",
      description: STOP_CONFIRM_MESSAGE,
      confirmLabel: "Stop run",
      destructive: true,
    });
    if (!ok) return;
    setPending(true);
    try {
      await stopSession(runId, auth.human?.id ?? null);
      toast({ title: "Stopping the run…", variant: "success", duration: 2500 });
      onStopped();
    } catch (err) {
      toast({
        title: "Could not stop the run",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setPending(false);
    }
  }

  const button = (
    <Button variant="danger" size="sm" loading={pending} disabled={!auth.can} onClick={stop} data-stop-run>
      <Square /> Stop
    </Button>
  );
  return auth.can ? button : <Tooltip label={auth.reason ?? "Only a person can stop a run"}>{button}</Tooltip>;
}

/** Rerun queues the same work again and moves to its live run. */
export function RerunButton({ auth, onRerun }: { auth: QaAuthority; onRerun: () => void }) {
  const button = (
    <Button size="sm" disabled={!auth.can} onClick={onRerun} data-rerun>
      <RotateCw /> Rerun
    </Button>
  );
  return auth.can ? button : <Tooltip label={auth.reason ?? "Only a person can start QA work"}>{button}</Tooltip>;
}
