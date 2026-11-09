import type { CSSProperties } from "react";
import { ArrowUpRight, Ban, Bug, Circle, CircleCheck, CircleDot, Contrast, type LucideIcon } from "../../map/kit/icons";
import { Link } from "../../map/kit";
import { runHref } from "../links";
import { LensChip } from "../lens-chip";
import type { CharterItem, CharterStatus } from "../explorations";
import { cn } from "../../map/kit";
import { CHARTER_LABEL } from "./model";
import styles from "./detail.module.css";

export const CHARTER_ICON: Record<CharterStatus, { icon: LucideIcon; tone: string }> = {
  planned: { icon: Circle, tone: "text-muted" },
  active: { icon: CircleDot, tone: "text-primary" },
  covered: { icon: CircleCheck, tone: "text-success" },
  partial: { icon: Contrast, tone: "text-warning" },
  blocked: { icon: Ban, tone: "text-muted" },
  bug: { icon: Bug, tone: "text-danger" },
};

export function CharterGlyph({ status, className }: { status: CharterStatus; className?: string }) {
  const { icon: Icon, tone } = CHARTER_ICON[status];
  return <Icon aria-hidden className={cn("size-4 shrink-0", tone, className)} strokeWidth={1.75} />;
}

/**
 * The charter as a checklist while exploring: each mission ticks as `charter_update` settles
 * it, the active one is highlighted.
 */
export function CharterChecklist({
  items,
  activeId,
  runId = null,
}: {
  items: readonly CharterItem[];
  activeId: string | null;
  /** The session: a mission that settled links to its step in the run. */
  runId?: string | null;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
        No charter yet. The explorer writes it after studying the app.
      </div>
    );
  }
  return (
    // One list, one line per mission (Linear-style): the active mission is marked by a fill, not a
    // box of its own.
    <ol className="flex flex-col overflow-hidden rounded-lg border border-border bg-panel" data-charter-checklist>
      {items.map((m, i) => {
        const active = m.id === activeId;
        return (
          <li
            key={m.id}
            data-charter-item={m.id}
            data-charter-status={m.status}
            aria-current={active ? "step" : undefined}
            className={cn(
              "v-rise relative flex min-h-11 items-center gap-2.5 px-3 py-2 [&+&]:border-t [&+&]:border-border/60",
              active && cn("bg-selected/70", styles.activeMission),
            )}
            style={{ "--i": i } as CSSProperties}
          >
            {/* Keyed on the status so the tick plays again when it changes. */}
            <span key={m.status} className={cn("shrink-0", m.status !== "planned" && styles.tick)}>
              <CharterGlyph status={m.status} />
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              {/* The title truncates (whole text on hover) instead of running under the lens chip; the
                  note gives way first. */}
              <span className={cn("min-w-0 truncate text-sm font-medium", m.status === "planned" ? "text-fg-2" : "text-fg")} title={m.title}>{m.title}</span>
              <span className="min-w-0 shrink-[3] truncate text-xs text-muted" title={m.note || m.why || undefined}>
                {m.note || m.why}
              </span>
              <span className="sr-only">{CHARTER_LABEL[m.status]}</span>
            </div>
            <span className="shrink-0">
              <LensChip lens={m.lens} size="sm" />
            </span>
            {/* Wide enough for "Partly covered" on one line. */}
            <span className="w-[5.5rem] shrink-0 whitespace-nowrap text-right">
              {runId && m.step_seq != null ? (
                <Link href={runHref(runId, m.step_seq)} className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg" data-charter-step>
                  Step {m.step_seq}
                  <ArrowUpRight aria-hidden className="size-3" />
                </Link>
              ) : (
                <span className={cn("text-2xs", active ? "text-primary" : "text-muted")}>{active ? "Now" : CHARTER_LABEL[m.status]}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
