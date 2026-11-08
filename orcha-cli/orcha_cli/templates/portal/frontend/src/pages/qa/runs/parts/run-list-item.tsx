import { StatusGlyph } from "../../map/kit";
import { verdictStyle, type RunVerdict } from "../lib/run-list";

/** The verdict glyph of a row, the run header and anywhere a run's outcome is summarised. */
export function RunVerdictGlyph({ verdict, size, className }: { verdict: RunVerdict; size?: number; className?: string }) {
  const s = verdictStyle(verdict);
  return <StatusGlyph status={s.glyph} label={s.label} colorClassName={s.color} size={size} className={className} />;
}

