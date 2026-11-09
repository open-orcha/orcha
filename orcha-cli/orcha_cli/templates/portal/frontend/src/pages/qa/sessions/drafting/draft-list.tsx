import { Link } from "../../map/kit";
import { useState } from "react";
import { Check, ChevronRight, Maximize2, Pencil, X } from "../../map/kit/icons";
import { Button, buttonVariants } from "../../map/kit";
import { Chip } from "../../map/kit";
import { PlatformScopeChip, displayScenarioName } from "../../scenarios/platform-status-strip";
import type { QaAuthority } from "../../authority";
import { Gated } from "./gated";
import type { Scenario } from "./lib/types";
import { cn } from "../../map/kit";

/**
 * Compact alternate view of the drafts (spec §"the new review experience" 1):
 * one row per draft with its status. A row expands in place to show the
 * description, criteria and feedback history, with Accept and "Open card"
 * (jump to that card in deck view) as quick actions. No checkboxes — the
 * card is where feedback and revision happen.
 */
export function DraftList({
  drafts,
  pendingIds,
  onJump,
  onAccept,
  onDiscard,
  discardLabel = "Discard",
  notes,
  tags,
  editHref,
  auth,
}: {
  /** Accepting and discarding are a person's: the buttons follow it. */
  auth: QaAuthority;
  /** Each row carries its platform scope ("iOS only" / "All platforms") once any draft is
   * pinned: the drafts then span several platforms. */
  drafts: readonly Scenario[];
  pendingIds: ReadonlySet<string>;
  onJump: (index: number) => void;
  onAccept?: (id: string) => void;
  /** Adds a two-click Discard (or `discardLabel`) to each expanded row. */
  onDiscard?: (id: string) => Promise<void> | void;
  discardLabel?: string;
  /** One muted line per draft id (an agent suggestion's kind and why). */
  notes?: ReadonlyMap<string, string>;
  tags?: ReadonlyMap<string, string>;
  /** Where "Edit" opens a draft for hand editing; no Edit button without it. */
  editHref?: (id: string) => string;
}) {
  const multiPlatform = drafts.some((d) => d.target_kind);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [armed, setArmed] = useState<string | null>(null);

  function discard(id: string) {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    void onDiscard?.(id);
  }

  function toggle(id: string) {
    setExpanded((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <ul className="flex flex-col gap-1.5" data-draft-list>
      {drafts.map((s, i) => {
        const revising = pendingIds.has(s.id);
        const validated = s.status === "validated";
        const open = expanded.has(s.id);
        const feedback = s.feedback ?? [];
        const note = notes?.get(s.id) ?? null;
        return (
          <li
            key={s.id}
            className={cn(
              "rounded-md border bg-panel transition-colors",
              "border-border",
            )}
            data-draft-card={s.id}
            data-draft-status={revising ? "revising" : s.status}
            data-draft-expanded={open ? "true" : undefined}
          >
            <button
              type="button"
              onClick={() => toggle(s.id)}
              aria-expanded={open}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover"
              data-draft-row
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-muted transition-transform",
                  open && "rotate-90",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg" title={s.name}>
                    {displayScenarioName(s.name, s.target_kind)}
                  </span>
                  {multiPlatform ? <PlatformScopeChip kind={s.target_kind} /> : null}
                </span>
                {note ? (
                  <span className="truncate text-xs text-muted" data-draft-note>
                    {note}
                  </span>
                ) : null}
              </span>
              <span className="hidden text-xs text-muted sm:inline">
                {s.criteria.length} criteri{s.criteria.length === 1 ? "on" : "a"}
              </span>
              {tags?.get(s.id) ? (
                <Chip className="max-sm:hidden" data-draft-origin>
                  {tags.get(s.id)}
                </Chip>
              ) : null}
              {s.category ? <Chip>{s.category}</Chip> : null}
              <Chip
                glyph={revising ? "running" : validated ? "pass" : "pending"}
                strong={validated || revising}
              >
                {revising ? "revising" : validated ? "accepted" : "draft"}
              </Chip>
            </button>

            {open ? (
              <div
                className="flex flex-col gap-2 border-t border-border px-3 py-2.5 pl-9"
                data-draft-details
              >
                {s.persona ? (
                  <span className="text-xs text-muted">Persona: {s.persona}</span>
                ) : null}
                {s.description ? (
                  <p className="text-sm text-muted">{s.description}</p>
                ) : null}
                {s.criteria.length > 0 ? (
                  <ol className="flex list-decimal flex-col gap-0.5 pl-4 text-sm text-fg">
                    {s.criteria.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted">No acceptance criteria yet.</p>
                )}

                {feedback.length > 0 ? (
                  <p className="text-xs text-muted" data-draft-feedback-count>
                    {feedback.length} feedback note{feedback.length === 1 ? "" : "s"} · last:{" "}
                    <span className="text-fg">{feedback[feedback.length - 1].text}</span>
                  </p>
                ) : null}
                <div className="flex items-center gap-2 pt-1">
                  {onAccept && !validated && !revising ? (
                    <Gated auth={auth}>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => onAccept(s.id)}
                        disabled={!auth.can}
                        data-draft-list-accept
                      >
                        <Check /> Accept
                      </Button>
                    </Gated>
                  ) : null}
                  {editHref ? (
                    <Link href={editHref(s.id)} className={buttonVariants({ size: "sm" })} data-draft-list-edit>
                      <Pencil /> Edit
                    </Link>
                  ) : null}
                  <Button size="sm" onClick={() => onJump(i)} data-draft-list-open>
                    <Maximize2 /> Open card
                  </Button>
                  {onDiscard && !revising ? (
                    <Gated auth={auth}>
                      <Button
                        size="sm"
                        variant={armed === s.id ? "danger" : "ghost"}
                        onClick={() => discard(s.id)}
                        disabled={!auth.can}
                        title={armed === s.id ? "Click again to confirm" : undefined}
                        data-draft-list-discard
                        data-draft-discard-armed={armed === s.id ? "true" : undefined}
                      >
                        <X /> {armed === s.id ? "Click to confirm" : discardLabel}
                      </Button>
                    </Gated>
                  ) : null}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
