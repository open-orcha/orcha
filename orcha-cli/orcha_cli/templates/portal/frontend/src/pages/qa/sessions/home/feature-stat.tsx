import type { CSSProperties } from "react";
import { Map as MapIcon } from "../../map/kit/icons";
import { CountUp } from "../../map/kit";
import { cn } from "../../map/kit";

/**
 * The header's "features explored" figure, read from the feature map.
 */
export function FeatureStat({ features, index }: { features: readonly { last_explored_at: string | null }[] | null; index: number }) {
  const visible = features ?? [];
  const explored = visible.filter((f) => f.last_explored_at).length;
  const share = visible.length > 0 ? explored / visible.length : 0;
  return (
    <div className="v-rise flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-panel/80 px-3.5 py-3 backdrop-blur-[2px]" style={{ "--i": index + 2 } as CSSProperties} data-explore-stat="features">
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <MapIcon aria-hidden className="size-3.5" strokeWidth={2} />
        Features explored
      </span>
      {features === null ? (
        <span className="v-skeleton my-1.5 h-5 w-16" />
      ) : (
        <span className="text-2xl font-semibold tabular tracking-tight text-fg">
          <CountUp value={String(explored)} delay={140 + index * 90} />
          <span className="text-base font-medium text-muted">
            {" "}
            of <CountUp value={String(visible.length)} delay={140 + index * 90} />
          </span>
        </span>
      )}
      <div className="flex min-h-4 items-center gap-2 text-xs text-muted">
        {visible.length > 0 ? (
          <>
            <span className="relative h-1 w-full max-w-[120px] overflow-hidden rounded-full bg-panel-2 ring-1 ring-inset ring-border" aria-hidden>
              <span className={cn("v-grow-x absolute inset-y-0 left-0 rounded-full bg-primary")} style={{ width: `${share * 100}%`, "--d": "320ms" } as CSSProperties} />
            </span>
            <span className="shrink-0 tabular">{visible.length - explored} in the fog</span>
          </>
        ) : features === null ? null : (
          "No feature map yet"
        )}
      </div>
    </div>
  );
}
