import { useEffect, useRef, useState } from "react";
import { Pencil, Sparkles } from "../../map/kit/icons";
import { Button, Chip, Link, buttonVariants, cn } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { PlatformScopeChip, displayScenarioName } from "../../scenarios/platform-status-strip";
import { TextDialog } from "../../scenarios/text-dialog";
import { StatusLine } from "./status-line";
import type { DraftEvidence } from "./lib/drafting-board";
import type { CorrectionBody, Scenario } from "./lib/types";
import { DraftEvidenceBlock, evidenceHeadline } from "./draft-evidence";
import { Gated } from "./gated";

export interface DraftCardHandle {
  focusFeedback: () => void;
}

/**
 * One card of the review deck (spec §"the new review experience" 2): name,
 * chips, status, description, criteria, a feedback textarea with "Revise
 * with AI", feedback history, and — once a revision lands — an "Updated"
 * flash and a link to the previous version.
 */
export function DraftCard({
  scenario,
  revising,
  reviseError,
  justUpdated,
  feedback,
  onFeedbackChange,
  onRevise,
  feedbackInputRef,
  note,
  tag,
  editHref,
  multiPlatform = false,
  evidence,
  previous = null,
  auth,
}: {
  /** Revising is a person's: the button follows it. */
  auth: QaAuthority;
  /** What backs each criterion (screens, code, corrections from screen; migration 095). */
  evidence?: DraftEvidence;
  /** The version its last revision replaced. */
  previous?: NonNullable<CorrectionBody["before"]> | null;
  /** The drafts span several platforms: a shared draft says "All platforms" too, not only a
   * pinned one its platform. */
  multiPlatform?: boolean;
  /** A small chip next to the category ("from exploration Oct 5"). */
  tag?: string | null;
  /** One muted line under the title (an agent suggestion's kind and why). */
  note?: string | null;
  /** Where "Edit" opens the scenario for hand editing; no Edit button without it. */
  editHref?: string | null;
  scenario: Scenario;
  revising: boolean;
  reviseError?: string | null;
  /** True for a brief window right after a revision's row update lands. */
  justUpdated: boolean;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onRevise: () => void;
  feedbackInputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const validated = scenario.status === "validated";
  const hasEvidence = evidence !== undefined && (evidence.rows.length > 0 || evidence.corrections.size > 0);
  const headline = evidenceHeadline(evidence, scenario.criteria.length);
  const [versionOpen, setVersionOpen] = useState(false);
  return (
    <div
      className={cn(
        "@container flex min-w-0 flex-col gap-3 rounded-lg border bg-panel p-4",
        justUpdated ? "border-border-strong" : "border-border",
        justUpdated && "animate-arrive",
      )}
      data-draft-card={scenario.id}
      data-draft-status={revising ? "revising" : scenario.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium text-fg" title={scenario.name}>
          {displayScenarioName(scenario.name, scenario.target_kind)}
        </span>
        {scenario.target_kind || multiPlatform ? <PlatformScopeChip kind={scenario.target_kind} className="h-6 px-2 text-xs" /> : null}
        {scenario.category ? <Chip>{scenario.category}</Chip> : null}
        {scenario.persona ? <Chip>{scenario.persona}</Chip> : null}
        {tag ? <Chip data-draft-origin>{tag}</Chip> : null}
        {headline ? (
          <Chip glyph={headline === "code only" ? "pending" : "pass"} data-draft-evidence-headline>
            {headline}
          </Chip>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {justUpdated ? (
            <Chip dot="bg-primary" strong data-draft-updated-flash>
              Updated
            </Chip>
          ) : null}
          {revising ? (
            <Chip glyph="running" strong data-draft-revising>
              Revising…
            </Chip>
          ) : (
            <Chip glyph={validated ? "pass" : "pending"} strong={validated}>
              {validated ? "accepted" : "draft"}
            </Chip>
          )}
        </span>
      </div>

      {note ? (
        <p className="flex items-start gap-1.5 text-xs text-muted" data-draft-note>
          <Sparkles aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>{note}</span>
        </p>
      ) : null}

      {scenario.description ? (
        <p className="text-sm text-muted">{scenario.description}</p>
      ) : null}

      {scenario.criteria.length > 0 && hasEvidence ? (
        <DraftEvidenceBlock criteria={scenario.criteria} evidence={evidence} />
      ) : scenario.criteria.length > 0 ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-fg">
          {scenario.criteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ol>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <label className="text-xs font-medium text-muted" htmlFor={`feedback-${scenario.id}`}>
          Feedback
        </label>
        <textarea
          id={`feedback-${scenario.id}`}
          ref={feedbackInputRef}
          value={feedback}
          onChange={(e) => onFeedbackChange(e.target.value)}
          disabled={revising}
          rows={2}
          placeholder={
            "What should change? e.g. 'Criterion 3 is wrong: the back link says Trips, not Income.'"
          }
          className="w-full resize-y rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-muted hover:border-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
          data-draft-feedback
        />
        <div className="flex items-center gap-2">
          <Gated auth={auth}>
            <Button
              size="sm"
              onClick={onRevise}
              disabled={!auth.can || revising || feedback.trim().length === 0}
              loading={revising}
              data-draft-revise
            >
              {revising ? null : <Sparkles />} {revising ? "Revising…" : "Revise with Embodent"}
            </Button>
          </Gated>
          {editHref ? (
            <Link href={editHref} className={buttonVariants({ size: "sm", variant: "ghost" })} data-draft-edit>
              <Pencil /> Edit
            </Link>
          ) : null}
          {justUpdated && previous ? (
            <button
              type="button"
              onClick={() => setVersionOpen(true)}
              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
              data-view-previous-version
            >
              View previous version
            </button>
          ) : null}
        </div>
        {reviseError ? (
          <div role="alert" data-draft-revise-error><StatusLine status="fail">
            {reviseError}
          </StatusLine></div>
        ) : null}
        {scenario.feedback.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted" data-feedback-history>
            {scenario.feedback.map((entry, i) => (
              <li key={i} className="truncate">
                <span className="text-fg">{entry.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <TextDialog
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        title="Previous version"
        description={scenario.name}
        text={previous ? previousText(previous) : "No previous version."}
      />
    </div>
  );
}

/** The version a revision replaced, in plain text. */
function previousText(v: NonNullable<CorrectionBody["before"]>): string {
  return [
    v.name ?? "",
    v.category ? `Category: ${v.category}` : "",
    v.persona ? `Persona: ${v.persona}` : "",
    v.description ?? "",
    ...(v.criteria ?? []).map((c, i) => `${i + 1}. ${c}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Tracks a "just updated" flag per scenario id, clearing it after a short window. */
export function useUpdatedFlash(): {
  flash: (id: string) => void;
  isFlashing: (id: string) => boolean;
} {
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
    };
  }, []);

  function flash(id: string) {
    setFlashing((set) => new Set(set).add(id));
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      setFlashing((set) => {
        if (!set.has(id)) return set;
        const next = new Set(set);
        next.delete(id);
        return next;
      });
      timers.current.delete(id);
    }, 4000);
    timers.current.set(id, timer);
  }

  return { flash, isFlashing: (id: string) => flashing.has(id) };
}
