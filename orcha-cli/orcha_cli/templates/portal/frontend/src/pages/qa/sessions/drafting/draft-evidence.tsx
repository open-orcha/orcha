import { useState } from "react";
import { Check, Code2, ScanEye } from "../../map/kit/icons";
import { ScreenThumb } from "../screen-thumb";
import {
  EVIDENCE_LABEL,
  evidenceCounts,
  evidenceTitle,
  filmstrip,
  type CriterionCorrection,
  type DraftEvidence,
  type FilmFrame,
} from "./lib/drafting-board";
import type { ScenarioEvidence } from "./lib/types";
import { cn } from "../../map/kit";

const BADGE: Record<ScenarioEvidence["status"], string> = {
  verified: "border-success/35 bg-success/10 text-success",
  unconfirmed: "border-dashed border-border-strong text-muted",
  code_only: "border-border text-fg-2",
};

/** A criterion's evidence: "verified on screen ✓", "unconfirmed" or "code only". */
export function EvidenceBadge({ row }: { row: ScenarioEvidence }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none",
        BADGE[row.status],
      )}
      title={evidenceTitle(row)}
      data-evidence-badge={row.status}
    >
      {row.status === "code_only" ? <Code2 aria-hidden className="size-3" /> : null}
      {row.status === "unconfirmed" ? <ScanEye aria-hidden className="size-3" /> : null}
      {EVIDENCE_LABEL[row.status]}
      {row.status === "verified" ? <Check aria-hidden className="size-3" strokeWidth={2.5} /> : null}
    </span>
  );
}

/** The criteria of a draft with what backs each one, and its corrections from screen. */
export function EvidenceCriteria({
  criteria,
  evidence,
  highlighted,
  onHighlight,
}: {
  criteria: readonly string[];
  evidence: DraftEvidence;
  highlighted: number | null;
  onHighlight: (index: number | null) => void;
}) {
  const byIndex = new Map(evidence.rows.map((r) => [r.criterion_index, r]));
  return (
    <ol className="flex flex-col gap-2 text-sm text-fg" data-evidence-criteria>
      {criteria.map((c, i) => {
        const row = byIndex.get(i);
        const fix = evidence.corrections.get(i);
        return (
          <li
            key={i}
            className={cn(
              "-mx-1.5 flex flex-col gap-1 rounded-md px-1.5 py-1 transition-colors duration-150",
              highlighted === i && "bg-hover",
            )}
            onMouseEnter={() => onHighlight(i)}
            onMouseLeave={() => onHighlight(null)}
            data-evidence-criterion={i}
          >
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 pt-px text-right text-xs tabular text-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1">
                <CriterionText text={c} />
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-6">
              {row ? <EvidenceBadge row={row} /> : null}
              {row?.code_ref ? (
                <span className="truncate font-mono text-[11px] text-muted" title={row.code_ref} data-evidence-code>
                  {row.code_ref}
                </span>
              ) : null}
              {fix ? <CorrectionChip fix={fix} /> : null}
            </div>
            {fix?.before ? (
              <p className="pl-6 text-xs text-muted" data-correction-before>
                <span className="mr-1 text-fg-2">Before:</span>
                <span className="line-through decoration-muted/70">
                  <CriterionText text={fix.before} />
                </span>
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A criterion with its `**bold**` labels drawn bold instead of as asterisks. */
export function CriterionText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-medium text-fg">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function CorrectionChip({ fix }: { fix: CriterionCorrection }) {
  const where = fix.screenName ? ` on ${fix.screenName}` : "";
  return (
    <span
      className="inline-flex h-5 items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-1.5 text-[11px] font-medium leading-none text-primary"
      title={`Corrected from what the explorer saw${where}${fix.reason ? `: ${fix.reason}` : ""}`}
      data-correction-chip
    >
      corrected from screen
    </span>
  );
}

/** The screens a draft is based on, beside its criteria; each opens full size. */
export function DraftFilmstrip({
  frames,
  highlighted,
  onHighlight,
  className,
}: {
  frames: readonly FilmFrame[];
  highlighted: number | null;
  onHighlight: (index: number | null) => void;
  className?: string;
}) {
  if (frames.length === 0) return null;
  return (
    <div
      className={cn("flex gap-2 overflow-x-auto @md:flex-col @md:overflow-visible", className)}
      aria-label="Screens this draft is based on"
      data-draft-filmstrip
    >
      {frames.map((f) => {
        const lit = highlighted != null && f.criteria.includes(highlighted);
        return (
          <figure key={f.path} className="w-[132px] shrink-0">
            <ScreenThumb
              src={f.url}
              label={f.label}
              description={f.step != null ? `Seen at step ${f.step} · backs criteria ${f.criteria.map((i) => i + 1).join(", ")}` : undefined}
              onHover={(on) => onHighlight(on ? f.criteria[0] : null)}
              imgClassName={cn(
                "h-[92px] w-[132px] transition-[border-color,box-shadow] duration-150",
                lit && "border-accent shadow-[0_0_0_1px_var(--color-accent)]",
              )}
              dataAttrs={{ "data-filmstrip-frame": f.path }}
            >
              <span
                className={cn(
                  "absolute left-1 top-1 z-10 inline-flex h-4 items-center gap-0.5 rounded px-1 text-[10px] font-medium tabular",
                  f.verified ? "bg-success text-white" : "bg-panel/90 text-fg-2 ring-1 ring-border",
                )}
              >
                {f.verified ? <Check aria-hidden className="size-2.5" strokeWidth={3} /> : null}
                {f.criteria.map((i) => i + 1).join(", ")}
              </span>
            </ScreenThumb>
            <figcaption className="mt-1 truncate text-[11px] text-muted" title={f.label}>
              {f.label}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/** "3 of 5 verified on screen" for the card's header. */
export function evidenceHeadline(evidence: DraftEvidence | undefined, total: number): string | null {
  if (!evidence || evidence.rows.length === 0) return null;
  const c = evidenceCounts(evidence.rows);
  if (c.code_only === evidence.rows.length) return "code only";
  return `${c.verified} of ${total} verified on screen`;
}

/** Criteria + filmstrip, side by side on a wide card, stacked on a narrow one. */
export function DraftEvidenceBlock({ criteria, evidence }: { criteria: readonly string[]; evidence: DraftEvidence }) {
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const frames = filmstrip(evidence.rows);
  return (
    <div
      className={cn("grid min-w-0 gap-3", frames.length > 0 && "@md:grid-cols-[minmax(0,1fr)_132px]")}
      data-draft-evidence
    >
      <EvidenceCriteria criteria={criteria} evidence={evidence} highlighted={highlighted} onHighlight={setHighlighted} />
      <DraftFilmstrip frames={frames} highlighted={highlighted} onHighlight={setHighlighted} />
    </div>
  );
}
