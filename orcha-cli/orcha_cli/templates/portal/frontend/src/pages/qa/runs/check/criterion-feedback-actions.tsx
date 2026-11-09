import { useState } from "react";
import { Ban, Check, ShieldCheck } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { Chip } from "../../map/kit";
import { Dialog } from "../../map/kit";
import { Input } from "../../map/kit";
import { useToast } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { putFeedback } from "../api";
import type { CriterionFeedbackStatus } from "../types";
import { cn } from "../../map/kit";

const STATUS_META: Record<
  CriterionFeedbackStatus,
  { label: string; icon: typeof Check; dot: string }
> = {
  not_a_bug: { label: "Not a bug", icon: Ban, dot: "bg-sev-minor" },
  acknowledged: { label: "Acknowledged", icon: ShieldCheck, dot: "bg-accent" },
  resolved: { label: "Resolved", icon: Check, dot: "bg-success" },
};

/**
 * "Not a bug" / "Acknowledged" / "Resolved" actions for one
 * criterion (spec §3 scope extension). Once a status is set it renders as a
 * chip instead of the action row; a fresh call can still overwrite it.
 */
export function CriterionFeedbackActions({
  runId,
  scenarioId,
  criterionIndex,
  initialStatus,
  criterionText,
  auth,
  className,
}: {
  runId: string;
  /** Answering a verdict is a person's call: the buttons wait for an acting human. */
  auth: QaAuthority;
  scenarioId: string;
  criterionIndex: number;
  initialStatus: CriterionFeedbackStatus | null;
  criterionText?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<CriterionFeedbackStatus | null>(initialStatus);
  const [pending, setPending] = useState<CriterionFeedbackStatus | null>(null);
  const [askWhy, setAskWhy] = useState(false);
  const [reason, setReason] = useState("");

  async function set(next: CriterionFeedbackStatus, note?: string) {
    setPending(next);
    try {
      await putFeedback(runId, { scenario_id: scenarioId, criterion_index: criterionIndex, status: next, note: note ?? null }, auth.human?.id ?? null);
      setStatus(next);
      setAskWhy(false);
      setReason("");
      if (next === "not_a_bug") toast({ title: "Saved", description: "Kept with this run.", variant: "success", duration: 3000 });
    } catch (err) {
      toast({
        title: "Could not save feedback",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setPending(null);
    }
  }

  if (status) {
    const meta = STATUS_META[status];
    const Icon = meta.icon;
    return (
      <Chip dot={meta.dot} strong data-criterion-feedback-status={status} className={className}>
        <Icon className="size-3" strokeWidth={2.5} />
        {meta.label}
      </Chip>
    );
  }

  const why = reason.trim();

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <Dialog
        open={askWhy}
        onClose={() => setAskWhy(false)}
        title="Why isn't this a bug?"
        description="Your answer stays with this run, so write it for someone who wasn't here."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setAskWhy(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={pending === "not_a_bug"}
              disabled={!why}
              onClick={() => void set("not_a_bug", why)}
              data-not-a-bug-save
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {criterionText ? (
            <p className="rounded-md border border-border bg-panel-2 px-2.5 py-2 text-sm text-muted">
              {criterionText}
            </p>
          ) : null}
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && why) void set("not_a_bug", why);
            }}
            placeholder="e.g. the tab bar is a single Group with no accessible children, so tapping by bounds is expected"
            data-not-a-bug-reason
          />
        </div>
      </Dialog>

      <Button
        variant="ghost"
        size="sm"
        loading={pending === "not_a_bug"}
        disabled={pending !== null || !auth.can}
        title={auth.can ? undefined : (auth.reason ?? undefined)}
        onClick={() => setAskWhy(true)}
      >
        Not a bug
      </Button>
      <Button
        variant="ghost"
        size="sm"
        loading={pending === "acknowledged"}
        disabled={pending !== null || !auth.can}
        title={auth.can ? undefined : (auth.reason ?? undefined)}
        onClick={() => set("acknowledged")}
      >
        Acknowledged
      </Button>
      <Button
        variant="ghost"
        size="sm"
        loading={pending === "resolved"}
        disabled={pending !== null || !auth.can}
        title={auth.can ? undefined : (auth.reason ?? undefined)}
        onClick={() => set("resolved")}
      >
        Resolved
      </Button>
    </div>
  );
}
