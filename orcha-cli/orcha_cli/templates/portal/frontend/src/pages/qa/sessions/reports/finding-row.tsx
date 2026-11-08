import { Moon, Sun } from "../../map/kit/icons";
import { severityDot } from "../../map/kit";
import { appearanceLabel, formatMeasurement, thresholdProgress } from "./exploration";
import { elementText, gaugeText, type MergedFinding } from "./exploration-list";
import { cn } from "../../map/kit";
import type { ExplorationFinding } from "./types";

/**
 * The measured number, always with its unit and always next to what it had to clear.
 *
 * The bar underneath is a *shortfall* gauge, not a progress bar, and that
 * distinction was a real bug on the first pass: drawn as `measured / threshold`,
 * "38pt against a 44pt floor" filled 86% of the track and read as almost passing,
 * while "48px past a 0px budget" filled it completely and read as done. Both are
 * failures. So the track is the requirement, the filled part is what the
 * measurement actually delivers, and the remainder is drawn in the danger colour
 * — the eye lands on the gap, which is the thing that is wrong.
 */
export function Measurement({
  finding,
  confident,
}: {
  finding: ExplorationFinding;
  confident: boolean;
}) {
  const m = formatMeasurement(finding);
  if (!m) return null;

  const progress = thresholdProgress(finding);
  const short = progress != null && progress < 1;

  return (
    <div className="flex flex-col gap-1.5" data-finding-measurement>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn(
            "font-mono text-base font-semibold leading-none tabular",
            confident ? "text-fg" : "text-muted",
          )}
        >
          {m.measured}
        </span>
        {m.requirement ? (
          <span className="font-mono text-xs leading-none tabular text-muted">
            {m.requirement}
          </span>
        ) : null}
      </div>

      {progress != null ? (
        <div
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-panel-2"
          role="img"
          aria-label={`Measured ${m.measured}; ${m.requirement ?? "no threshold"}`}
        >
          <span
            className={cn("h-full", confident ? "bg-fg/45" : "bg-muted/40")}
            style={{ width: `${progress * 100}%` }}
          />
          {short ? (
            // The shortfall. An estimate never wears the alarm colour.
            <span className={cn("h-full flex-1", confident ? "bg-danger" : "bg-muted/25")} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The row's gauge: `3.97 → 4.5` and a 32px shortfall track — the same encoding as
 * `Measurement`, shrunk to fit a 36px row so the size of the miss is readable
 * while scanning, without opening anything.
 */
function InlineGauge({ finding, confident }: { finding: ExplorationFinding; confident: boolean }) {
  const g = gaugeText(finding);
  if (!g) return <span aria-hidden className="hidden w-[118px] sm:block" />;
  const progress = thresholdProgress(finding);
  return (
    <span
      className="hidden w-[118px] items-center justify-end gap-2 sm:flex"
      title={formatMeasurement(finding)?.requirement ?? undefined}
    >
      <span className="truncate font-mono text-xs tabular">
        <span className={confident ? "text-fg" : "text-muted"}>{g.measured}</span>
        {g.threshold ? <span className="text-muted"> → {g.threshold}</span> : null}
        {g.unit ? <span className="text-muted"> {g.unit}</span> : null}
      </span>
      {progress != null ? (
        <span aria-hidden className="flex h-1 w-8 shrink-0 overflow-hidden rounded-full bg-panel-2">
          <span
            className={cn("h-full", confident ? "bg-fg/45" : "bg-muted/40")}
            style={{ width: `${progress * 100}%` }}
          />
          {progress < 1 ? (
            <span className={cn("h-full flex-1", confident ? "bg-danger" : "bg-muted/25")} />
          ) : null}
        </span>
      ) : (
        <span aria-hidden className="w-8 shrink-0" />
      )}
    </span>
  );
}

/**
 * One merged finding as a 36px Linear row: severity dot · element · gauge · ×N ·
 * screen · appearance. Everything else (the sentence, the screenshot, the list of
 * screens) lives in the detail panel, which is what lets a thousand findings fit
 * on a page.
 *
 * An unconfident finding keeps its number but trades the severity dot for a dashed
 * ring and mutes its text: the measurement is sound, the reading of it is not, and
 * the row must not look like a failure.
 */
export function DenseFindingRow({
  row,
  sectionKey,
  selected,
  onSelect,
  style,
}: {
  row: MergedFinding;
  sectionKey: string;
  selected: boolean;
  onSelect: () => void;
  style?: React.CSSProperties;
}) {
  const f = row.head;
  const confident = row.confident;
  const count = row.findings.length;
  const screens = row.screens.length;
  const dark = f.appearance === "dark";
  const label = elementText(f);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-exploration-finding={f.id}
      data-finding-row={row.key}
      data-finding-kind={f.kind}
      data-finding-confident={confident ? "yes" : "no"}
      data-finding-section={sectionKey}
      data-severity={row.severity}
      style={style}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md pl-9 pr-2.5 text-left text-sm transition-colors duration-[90ms]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      {confident ? (
        <i aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", severityDot[row.severity])} />
      ) : (
        <i aria-hidden className="inline-block size-2 shrink-0 rounded-full border border-dashed border-muted" />
      )}
      <span className="sr-only">{confident ? row.severity : "needs a look"}</span>

      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn("truncate", confident ? "text-fg" : "text-muted")}>{label}</span>
        {f.element_identifier && f.element_identifier !== label ? (
          <code className="hidden min-w-0 truncate font-mono text-2xs text-muted md:inline">
            {f.element_identifier}
          </code>
        ) : null}
      </span>

      <InlineGauge finding={f} confident={confident} />

      <span
        className={cn(
          "w-10 shrink-0 text-right font-mono text-xs tabular",
          count > 1 ? "text-fg-2" : "text-transparent",
        )}
        title={count > 1 ? `${count} occurrences on ${screens} ${screens === 1 ? "screen" : "screens"}` : undefined}
        data-finding-count={count}
      >
        ×{count}
      </span>

      <span className="hidden w-16 shrink-0 truncate text-right font-mono text-2xs text-muted lg:inline">
        {screens > 1 ? `${screens} screens` : (f.screen_hash ?? "?").slice(0, 6)}
      </span>

      <span
        className="flex w-3.5 shrink-0 justify-center text-muted"
        title={f.appearance ? `Measured in ${appearanceLabel(f.appearance)}` : "Either appearance"}
      >
        {f.appearance ? (
          dark ? (
            <Moon className="size-3" strokeWidth={1.75} aria-label="Dark" />
          ) : (
            <Sun className="size-3" strokeWidth={1.75} aria-label="Light" />
          )
        ) : null}
      </span>
    </button>
  );
}
