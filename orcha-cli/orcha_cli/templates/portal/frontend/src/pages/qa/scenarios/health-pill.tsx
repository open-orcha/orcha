import { StatusGlyph, cn, type GlyphStatus } from "../map/kit";
import type { Scenario } from "./adapt";

// Colour lives in the glyph only; the label stays neutral text.
const STYLE: Record<"healthy" | "flaky" | "failing", { glyph: GlyphStatus; label: string }> = {
  healthy: { glyph: "pass", label: "stable" },
  flaky: { glyph: "flaky", label: "flaky" },
  failing: { glyph: "fail", label: "failing" },
};

/** Small scenario health pill: `stable` / `flaky` / `failing`; nothing until it was checked. */
export function HealthBadge({ health, className }: { health: Scenario["health"] | undefined; className?: string }) {
  if (!health) return null;
  const s = STYLE[health];
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] font-medium leading-none text-fg-2", className)} title={`Health: ${s.label}`} data-health-badge={health}>
      <StatusGlyph status={s.glyph} decorative size={10} />
      {s.label}
    </span>
  );
}
