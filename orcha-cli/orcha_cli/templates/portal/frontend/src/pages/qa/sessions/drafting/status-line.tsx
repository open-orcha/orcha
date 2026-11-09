import type { ReactNode } from "react";
import { StatusGlyph, cn, type GlyphStatus } from "../../map/kit";

/** One status with its glyph and its words. */
export function StatusLine({ status, children, className }: { status: GlyphStatus; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-8 items-center gap-2.5 text-sm text-fg", className)} data-status-line={status}>
      <StatusGlyph status={status} size={14} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
