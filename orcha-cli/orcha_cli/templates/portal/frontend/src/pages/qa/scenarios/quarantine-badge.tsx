import { ShieldOff } from "../map/kit/icons";
import { cn } from "../map/kit";

/** `"2 of 5 clean passes"`, or `"2 clean passes"` when the release threshold is unknown. */
export function cleanRunsLabel(clean: number | null | undefined, releaseAfter?: number | null): string {
  const n = clean ?? 0;
  const noun = `clean pass${n === 1 && !releaseAfter ? "" : "es"}`;
  return releaseAfter ? `${n} of ${releaseAfter} ${noun}` : `${n} ${noun}`;
}

/**
 * Quiet pill (no colour fill; a stroke icon) for a scenario in flaky quarantine (migration 032): it still runs and reports, but
 * a failure does not fail the check. Renders nothing when not quarantined.
 */
export function QuarantineBadge({
  quarantinedAt,
  reason,
  className,
}: {
  quarantinedAt: string | null | undefined;
  reason?: string | null;
  className?: string;
}) {
  if (!quarantinedAt) return null;
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] font-medium leading-none text-fg-2",
        className,
      )}
      title={`Quarantined: ${reason || "flaky"}. Still runs; a failure does not fail the check.`}
      data-quarantine-badge
    >
      <ShieldOff aria-hidden className="size-3 text-muted" strokeWidth={1.75} />
      quarantined
    </span>
  );
}
