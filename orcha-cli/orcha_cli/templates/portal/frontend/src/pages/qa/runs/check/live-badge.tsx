import { cn } from "../../map/kit";

/** "Live" pill shown on the replay pane while a run is streaming: a hairline pill with a dot
 * in the running colour that breathes (`v-live`; still under reduced motion). */
export function LiveBadge({ className }: { className?: string }) {
  return (
    <span
      data-live-badge
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-progress/35 bg-progress/10 px-2 text-xs font-medium text-fg",
        className,
      )}
    >
      <span aria-hidden className="v-live size-1.5 text-progress" />
      Live
    </span>
  );
}
