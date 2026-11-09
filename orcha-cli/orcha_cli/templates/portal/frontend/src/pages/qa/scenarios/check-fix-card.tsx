import { useState } from "react";
import { errText } from "../parts";
import { dismissCheckFix } from "./api";
import { useScenarios } from "./context";
import { ArrowRight } from "../map/kit/icons";
import { Button } from "../map/kit";
import { StatusGlyph } from "../map/kit";
import { CHECK_FIX_KIND_LABEL, type CheckFix } from "./check-fixes";

type State = "idle" | "accepting" | "dismissing" | "accepted" | "dismissed" | { error: string };

/** What the card says, by kind: a repair the run applied, a late report, or a proposal. */
function copy(fix: CheckFix): { title: string; body: string; accept: string; dismiss: string } {
  if (fix.applied) {
    return {
      title: "Check repaired for this run",
      body: "The criterion's own words say this line checks the wrong moment, so the run judged the repaired line instead. Keep it to save it to the scenario, or undo it to run the line as written from now on.",
      accept: fix.proposed ? "Keep repair" : "Keep repair (remove line)",
      dismiss: "Undo",
    };
  }
  if (fix.kind === "late") {
    return {
      title: "Reported late",
      body: "The check held on the screen that showed this criterion; the agent reported it after its own next action removed it. The line is right, and the app did nothing wrong.",
      accept: "",
      dismiss: "Dismiss",
    };
  }
  if (fix.kind === "unheld") {
    return {
      title: "Check needs fixing",
      body: "The line never held on this criterion's screens, and the agent judged the criterion met. It likely names something that stays on screen, such as the option just picked. Change or remove the line.",
      accept: "",
      dismiss: "Dismiss",
    };
  }
  return {
    title: "Check needs fixing",
    body: "The agent judged it passed and the screens show the check is wrong, not the product.",
    accept: "Accept fix",
    dismiss: "Dismiss",
  };
}

/**
 * "Check needs fixing" (#191): the run showed the check is wrong, not the product. Shows why, the
 * line as written and the corrected one, and accepts it into the scenario (a new version) or
 * dismisses it. Used on a run's criterion and in the scenario panel's checks. A repair the run
 * already applied (#226) is kept (saved) or undone (dismissed) the same way.
 */
export function CheckFixCard({
  fix,
  scenarioId,
  criterionIndex,
  onAccept,
  onAccepted,
  onDismissed,
  compact = false,
}: {
  fix: CheckFix;
  scenarioId: string | null;
  criterionIndex: number;
  /** Saves the corrected line into the scenario (a new version); throws when it could not. */
  onAccept?: (proposed: string) => Promise<void>;
  onAccepted?: (proposed: string) => void;
  onDismissed?: () => void;
  /** The scenario panel's version: no heading, the panel already says which criterion. */
  compact?: boolean;
}) {
  const { auth } = useScenarios();
  const actor = auth.human?.id ?? null;
  const [state, setState] = useState<State>("idle");
  const busy = state === "accepting" || state === "dismissing";
  const words = copy(fix);
  const canAccept = fix.proposed !== null || fix.applied === true;

  async function send(kind: "accept" | "dismiss") {
    if (!scenarioId) return;
    setState(kind === "accept" ? "accepting" : "dismissing");
    try {
      if (kind === "accept") {
        await onAccept?.(fix.proposed ?? "");
        setState("accepted");
        onAccepted?.(fix.proposed ?? "");
      } else {
        await dismissCheckFix(scenarioId, actor, { criterion_index: criterionIndex, expression: fix.expression, proposed: fix.proposed ?? "" });
        setState("dismissed");
        onDismissed?.();
      }
    } catch (err) {
      setState({ error: errText(err) });
    }
  }

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 py-2"
      data-check-fix={fix.kind}
      data-check-repair={fix.applied ? "applied" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {!compact ? (
          <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <StatusGlyph status="warning" decorative className="size-3.5" />
            {words.title}
          </span>
        ) : null}
        <span className="inline-flex h-[18px] items-center rounded-full border border-border px-1.5 text-[11px] font-medium leading-none text-fg-2">{CHECK_FIX_KIND_LABEL[fix.kind]}</span>
      </div>
      <p className="text-xs leading-5 text-fg-2">
        {words.body}
        {fix.reason ? <span className="text-muted"> Why: {fix.reason}.</span> : null}
      </p>
      <div className="flex min-w-0 flex-col gap-1 font-mono text-xs sm:flex-row sm:items-center sm:gap-2">
        <span className="min-w-0 break-words text-muted line-through decoration-border-strong" data-check-fix-old>
          {fix.expression}
        </span>
        {fix.proposed ? (
          <>
            <ArrowRight className="hidden size-3 shrink-0 text-muted sm:block" aria-hidden />
            <span className="min-w-0 break-words text-fg" data-check-fix-new>
              <span className="sr-only">Corrected check: </span>
              {fix.proposed}
            </span>
          </>
        ) : null}
      </div>
      {!fix.proposed && fix.applied ? <p className="text-xs text-muted">Another line of the criterion already checks it; the run left this one out.</p> : null}
      {!fix.proposed && !fix.applied && fix.kind !== "late" ? (
        <p className="text-xs text-muted">No correction could be derived from the screens; edit the check by hand.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        {state === "accepted" ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted" data-check-fix-state="accepted">
            <StatusGlyph status="pass" decorative className="size-3" />
            Saved to the scenario as a new version
          </span>
        ) : state === "dismissed" ? (
          <span className="text-xs text-muted" data-check-fix-state="dismissed">
            {fix.applied ? "Undone: later runs run the line as written" : "Dismissed"}
          </span>
        ) : scenarioId ? (
          <>
            {canAccept && words.accept ? (
              <Button size="sm" variant="primary" disabled={busy || !auth.can} aria-busy={state === "accepting"} onClick={() => void send("accept")}>
                {state === "accepting" ? "Saving…" : words.accept}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy || !auth.can} aria-busy={state === "dismissing"} onClick={() => void send("dismiss")}>
              {words.dismiss}
            </Button>
          </>
        ) : null}
        {typeof state === "object" ? (
          <span className="inline-flex items-center gap-1 text-xs text-danger" role="alert">
            <StatusGlyph status="fail" decorative className="size-3" />
            {state.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
