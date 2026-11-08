import { Button, StatusGlyph } from "../../map/kit";

const sentence = (s: string) => {
  const t = s.trim();
  return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/([^.!?])$/, "$1.");
};

/**
 * The run page's line for an abandoned run: it stopped reporting with nothing to finish it, so the
 * portal closed it. Says what happened, in place of Live, Stop and an elapsed clock, and offers the
 * same work again.
 */
export function AbandonedRunBanner({ reason, onRerun }: { reason: string; onRerun?: (() => void) | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-panel px-4.5 py-2 max-md:px-4" role="status" data-run-abandoned>
      <p className="flex min-h-6 min-w-0 flex-1 items-center gap-2 text-sm text-fg">
        <StatusGlyph status="blocked" decorative className="size-3.5 shrink-0" />
        <span>{sentence(reason)} Nothing is running it now.</span>
      </p>
      {onRerun ? <Button size="sm" variant="primary" onClick={onRerun} data-run-again>Run again</Button> : null}
    </div>
  );
}
