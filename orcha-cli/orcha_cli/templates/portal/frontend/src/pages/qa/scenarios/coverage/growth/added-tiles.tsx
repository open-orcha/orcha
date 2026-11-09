import type { CSSProperties } from "react";
import { ListChecks, Rows3, ScanEye } from "../../../map/kit/icons";
import { CountUp } from "../../../map/kit";
import { cn } from "../../../map/kit";
import { addedTiles } from "./growth-model";
import styles from "./growth.module.css";
import type { CoverageGrowth } from "./types";

const ICON = { scenarios: ListChecks, variations: Rows3, screens: ScanEye } as const;

/** What earns a tile that is still empty. */
const EARN: Record<string, string> = {
  scenarios: "Approve a drafted scenario and let it pass",
  variations: "Approve suggested rows in Data depth below",
  screens: "Run an exploration or Map the app",
};

/** Up to three names, then "and N more". */
function namesLine(names: string[], total: number): string {
  if (!names.length) return "";
  const shown = names.slice(0, 2);
  const more = total - shown.length;
  return shown.map((n) => `‘${n}’`).join(", ") + (more > 0 ? ` and ${more} more` : "");
}

/**
 * "Orcha added": three achievements. An earned one gets its medal, a glint and the names of
 * what earned it (the scenarios, the screens newly reached); an empty one says how it is earned.
 */
export function AddedTiles({ report }: { report: CoverageGrowth }) {
  const g = report.growth;
  const a = g?.overall.added;
  const flowName = new Map(report.now.flows.map((f) => [f.id, f.name]));
  const screenName = new Map(report.now.screens.map((s) => [s.id, s.name]));
  const detail: Record<string, string> = {
    scenarios: a ? namesLine(a.scenario_ids.map((id) => flowName.get(id)).filter((n): n is string => !!n), a.scenarios) : "",
    variations: report.variations.applied > 0 ? `${report.variations.applied} approved ${report.variations.applied === 1 ? "row is" : "rows are"} in your tables` : "",
    screens: a ? namesLine(a.screens.map((id) => screenName.get(id)).filter((n): n is string => !!n), a.screens_reached) : "",
  };
  return (
    <section aria-label="What Embodent added since the baseline" className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-growth-added>
      {addedTiles(g).map((tile, i) => {
        const Icon = ICON[tile.key as keyof typeof ICON] ?? ListChecks;
        const earned = tile.value > 0;
        return (
          <div key={tile.key} className={cn(styles.badge, "v-rise flex items-start gap-3 p-4")} style={{ "--i": i } as CSSProperties} data-earned={earned} data-growth-tile={tile.key}>
            <span className={styles.medal} style={{ "--i": i } as CSSProperties} aria-hidden>
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">Embodent added</p>
              <p className="flex items-baseline gap-1.5">
                <CountUp value={String(tile.value)} delay={300 + i * 140} className={cn("text-2xl font-semibold tabular-nums", earned ? "text-fg" : "text-muted")} />
                <span className="text-sm text-fg-2">{tile.label}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted">{tile.hint}</p>
              {earned && detail[tile.key] ? (
                <p className="mt-1.5 line-clamp-2 text-xs text-fg-2" title={detail[tile.key]}>
                  {detail[tile.key]}
                </p>
              ) : !earned ? (
                <p className="mt-1.5 text-xs text-fg-2">None yet. {EARN[tile.key]}.</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
