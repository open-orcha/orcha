import { TriangleAlert } from "../map/kit/icons";
import { Button, Link, PLATFORM_LABELS, type TargetKind } from "../map/kit";
import { qaHref } from "../parts";
import type { FitWarning } from "./scenario-platform";

/**
 * "These checks use iOS labels, so Android can't judge them." on a scenario, with what a person
 * can do about it. It only informs: until someone picks an action the scenario runs as before.
 * Limit pins this scenario; Split makes drafts and leaves this one alone.
 */
export function PlatformFitNote({
  warning,
  drafts,
  splitDone,
  busy,
  onLimit,
  onSplit,
  onKeep,
}: {
  warning: FitWarning;
  /** The drafts a split already made. */
  drafts: readonly { id: string; name: string }[];
  /** Every platform has its draft: nothing is left to split. */
  splitDone: boolean;
  busy: boolean;
  onLimit: (kind: TargetKind) => void;
  onSplit: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="mx-4 mb-3.5 flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5" data-scenario-platform-fit>
      <p className="flex items-start gap-2 text-sm font-medium text-fg">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        {warning.text}
      </p>
      <p className="line-clamp-3 text-xs text-muted" title={warning.detail}>
        {warning.detail}
      </p>
      <p className="text-xs text-muted">Nothing changes until you choose: it keeps running on every platform.</p>
      {drafts.length > 0 ? (
        <p className="text-xs text-fg-2" data-platform-fit-drafts>
          Split into{" "}
          {drafts.map((d, i) => (
            <span key={d.id}>
              {i > 0 ? ", " : null}
              <Link href={qaHref({ view: "scenarios", scenario: d.id })} className="font-medium text-fg underline underline-offset-2">
                {d.name}
              </Link>
            </span>
          ))}
          . Validate them, then retire this one.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {warning.limitTo ? (
          <Button size="sm" disabled={busy} onClick={() => onLimit(warning.limitTo as TargetKind)} data-platform-fit-limit={warning.limitTo}>
            Limit to {PLATFORM_LABELS[warning.limitTo]}
          </Button>
        ) : null}
        {splitDone ? null : (
          <Button size="sm" disabled={busy} onClick={onSplit} data-platform-fit-split>
            Split into a draft per platform
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onKeep} data-platform-fit-keep>
          Keep on all platforms
        </Button>
      </div>
    </div>
  );
}
