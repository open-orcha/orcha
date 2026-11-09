import { RotateCw } from "../../map/kit/icons";
import { Button, StatusGlyph, cn } from "../../map/kit";

export interface FailureExplanation {
  category: "cancelled" | "configuration" | "failed";
  sentence: string;
  code: string | null;
}

/**
 * A failed run in one sentence: what happened, and the next action. The stored reason is shown as
 * the session wrote it. `onRetry` is how this surface retries: Run check, gated by the caller.
 */
export function FailureExplainer({
  failure,
  onRetry,
  compact = false,
  className,
}: {
  failure: FailureExplanation;
  onRetry?: (() => void) | null;
  /** One line for a list row: no button, just the sentence. */
  compact?: boolean;
  className?: string;
}) {
  const glyph = failure.category === "cancelled" ? "cancelled" : failure.category === "configuration" ? "blocked" : "fail";
  if (compact) {
    return (
      <p className={cn("min-w-0 select-text truncate text-xs text-muted", className)} title={failure.sentence} data-failure-category={failure.category}>
        {failure.sentence}
      </p>
    );
  }
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm", className)}
      data-failure-explainer
      data-failure-category={failure.category}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <StatusGlyph status={glyph} size={14} decorative className="mt-[3px] shrink-0" />
        <span className="min-w-0 select-text text-fg" data-failure-sentence>
          {failure.sentence}
          {failure.code ? (
            <span className="ml-2 inline-block rounded border border-border px-1 align-[1px] font-mono text-2xs leading-4 text-muted" data-error-code>
              {failure.code}
            </span>
          ) : null}
        </span>
      </span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry} data-failure-action="retry">
          <RotateCw /> Run again
        </Button>
      ) : null}
    </div>
  );
}
