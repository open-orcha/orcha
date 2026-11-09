import { useState } from "react";
import { Link } from "../../map/kit";
import { ArrowUpRight, ChevronRight } from "../../map/kit/icons";
import { severityDot } from "../../map/kit";
import { sevRank } from "../../map/kit";
import { cn } from "../../map/kit";
import type { Finding } from "./types";
import { runHref } from "../links";

/**
 * The agent's own findings from the exploration's run — what it judged to be a defect while
 * walking, graded by the agent. They sit in the Judged tab, next to the impressions, and
 * never in the measured list: the severity here is an opinion about impact, not a number
 * against a threshold, and the page keeps the two apart on purpose.
 *
 * The same dense 36px rows as the measured list. There are a handful per exploration, not a
 * thousand, so a row expands in place (expected / actual / note) instead of opening a panel.
 */
export function JudgedFindings({ findings }: { findings: readonly Finding[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  if (findings.length === 0) {
    return (
      <div
        className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted"
        data-exploration-judged-empty
      >
        The agent reported no defects in this exploration.
      </div>
    );
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sorted = [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.seq - b.seq);
  return (
    <ul className="flex flex-col rounded-lg border border-border bg-panel p-1" data-exploration-judged>
      {sorted.map((f) => {
        const step = f.repro_to_step ?? f.repro_from_step;
        const href = runHref(f.run_id, step);
        const expandable = Boolean(f.expected || f.actual || f.note);
        const expanded = open.has(f.id);
        return (
          <li key={f.id} data-judged-finding={f.id} data-severity={f.severity}>
            <div
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-[90ms]",
                expanded ? "bg-selected" : "hover:bg-hover",
              )}
            >
              <button
                type="button"
                onClick={() => expandable && toggle(f.id)}
                aria-expanded={expandable ? expanded : undefined}
                disabled={!expandable}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none disabled:cursor-default"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 text-muted transition-transform",
                    expanded && "rotate-90",
                    !expandable && "invisible",
                  )}
                />
                <i aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", severityDot[f.severity])} />
                <span className="sr-only">{f.severity}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{f.title}</span>
              </button>
              <span className="hidden w-16 shrink-0 text-right text-xs text-muted sm:inline">{f.severity}</span>
              {f.qa?.status !== "open" ? <span className="shrink-0 text-xs text-muted">{f.qa?.status}</span> : null}
              <Link
                href={href}
                className="inline-flex w-16 shrink-0 items-center justify-end gap-0.5 text-xs text-muted transition-colors hover:text-fg"
                title="Open the run at the step where this was found"
              >
                {step != null ? `step ${step}` : "run"}
                <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            </div>
            {expanded ? (
              <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pl-[46px] pt-1.5">
                {f.expected || f.actual ? (
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {f.expected ? (
                      <>
                        <span className="text-muted">Expected</span>
                        <span className="select-text text-fg-2">{(f.expected)}</span>
                      </>
                    ) : null}
                    {f.actual ? (
                      <>
                        <span className="text-muted">Actual</span>
                        <span className="select-text text-fg-2">{(f.actual)}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
                {f.note ? <p className="text-xs leading-snug text-muted">{f.note}</p> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
