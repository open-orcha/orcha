import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check, LayoutList, LayoutPanelTop, Trash2 } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import type { QaAuthority } from "../../authority";
import { clampIndex, dotState, nextUndecidedIndex } from "./lib/draft-review";
import type { DraftEvidence } from "./lib/drafting-board";
import type { CorrectionBody, Scenario } from "./lib/types";
import { cn } from "../../map/kit";
import { DraftCard, useUpdatedFlash } from "./draft-card";
import { DraftList } from "./draft-list";
import { Gated } from "./gated";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  // The custom Select's trigger (components/ui/select.tsx) stands in for a native <select>.
  if (el.getAttribute("role") === "combobox") return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const positionStorageKey = (key: string) => `orcha:review-position:${key}`;

/** The draft id last on screen in the review keyed `key` (this tab), or null. */
function readPosition(key: string | null | undefined): string | null {
  if (!key || typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(positionStorageKey(key));
  } catch {
    return null;
  }
}

function writePosition(key: string, id: string): void {
  try {
    window.sessionStorage.setItem(positionStorageKey(key), id);
  } catch {
    // Storage blocked: the review reopens on its first card.
  }
}

export type DeckView = "cards" | "list";

/**
 * Card-by-card review deck (spec §"the new review experience"). Once drafts
 * exist this replaces the flat checkbox list: a header (position, dot strip,
 * List/Cards toggle, Accept all/remaining), the current card with a slide
 * transition, and a footer (Previous/Discard/Accept/Next). Keyboard: ←/→
 * navigate, `a` accepts, `d` discards, `/` focuses feedback.
 */
export function DraftDeck({
  drafts,
  pendingIds,
  errors,
  feedbackDrafts,
  onFeedbackChange,
  onRevise,
  onAccept,
  onDiscard,
  onAcceptAll,
  onAcceptRemaining,
  recentlyUpdatedIds,
  initialView = "cards",
  discardLabel = "Discard",
  notes,
  tags,
  editHref,
  evidence,
  versions,
  positionKey,
  auth,
}: {
  /** Accepting, discarding and revising are a person's: the buttons follow it. */
  auth: QaAuthority;
  /** What backs each draft's criteria (migration 095). */
  evidence?: ReadonlyMap<string, DraftEvidence>;
  /** The version each draft's last revision replaced. */
  versions?: ReadonlyMap<string, NonNullable<CorrectionBody["before"]>>;
  /** Which view opens first (the recording page lists its suggestions). */
  initialView?: DeckView;
  /** "Dismiss" for agent suggestions; "Discard" otherwise. */
  discardLabel?: string;
  /** One muted line per draft id, shown on its card and list row. */
  notes?: ReadonlyMap<string, string>;
  /** A small chip per draft, e.g. "from exploration Oct 5" for drafts of a follow-up pass. */
  tags?: ReadonlyMap<string, string>;
  /** Where "Edit" opens a draft for hand editing; no Edit button without it. */
  editHref?: (id: string) => string;
  /** Remember which draft is on screen under this key (the drafting request), so leaving the
   * review (Open run, Edit) and coming back reopens it on the same card. */
  positionKey?: string | null;
  drafts: readonly Scenario[];
  pendingIds: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  feedbackDrafts: ReadonlyMap<string, string>;
  onFeedbackChange: (id: string, value: string) => void;
  onRevise: (id: string) => void;
  onAccept: (id: string) => void;
  onDiscard: (id: string) => Promise<void> | void;
  onAcceptAll: () => void;
  onAcceptRemaining: () => void;
  recentlyUpdatedIds: ReadonlySet<string>;
}) {
  const [index, setIndex] = useState(0);
  /** The card to reopen on (`positionKey`), until it has streamed in or the reviewer moves. */
  const [restoreId, setRestoreId] = useState<string | null>(() => readPosition(positionKey));
  if (restoreId !== null) {
    const at = drafts.findIndex((d) => d.id === restoreId);
    if (at >= 0) {
      setRestoreId(null);
      setIndex(at);
    }
  }
  const [view, setView] = useState<DeckView>(initialView);
  const [direction, setDirection] = useState<"left" | "right">("right");
  /** Two-click confirm: the id of the card armed by a first Discard click, cleared
   * after a few seconds or once the second click fires the real discard (no native
   * `<dialog>` confirm: the deck also renders inside dialogs, and Chromium's modal
   * `<dialog>` stack does not nest cleanly). */
  const [armedDiscard, setArmedDiscard] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Mirrors `armedDiscard` synchronously: two clicks fired faster than a React
   * render (as Playwright's back-to-back `.click()` calls can) would otherwise both
   * read the same stale `armedDiscard` from the last commit and take the "arm"
   * branch, never confirming. The ref is always current the instant a click handler
   * runs, regardless of whether a render has flushed yet. */
  const armedRef = useRef<string | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const { flash, isFlashing } = useUpdatedFlash();
  const flashed = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, []);

  // Derived, not synced back into state: `index` may point past the end right
  // after a discard removes the last card, and clamping on every render (rather
  // than writing `index` back in an effect) keeps that a pure render-time fact.
  const clamped = clampIndex(index, drafts.length);
  const current = drafts[clamped] ?? null;
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (positionKey && currentId && restoreId === null) writePosition(positionKey, currentId);
  }, [positionKey, currentId, restoreId]);

  // Fire the "Updated" flash once per scenario id the caller reports as freshly revised.
  useEffect(() => {
    for (const id of recentlyUpdatedIds) {
      if (!flashed.current.has(id)) {
        flashed.current.add(id);
        flash(id);
      }
    }
  }, [recentlyUpdatedIds, flash]);

  function go(delta: number) {
    if (drafts.length === 0) return;
    setRestoreId(null);
    setDirection(delta > 0 ? "right" : "left");
    setIndex((i) => {
      const from = clampIndex(i, drafts.length);
      return (from + delta + drafts.length) % drafts.length;
    });
  }

  function jump(target: number) {
    setRestoreId(null);
    setDirection(target >= clamped ? "right" : "left");
    setIndex(target);
  }

  const acceptedCount = drafts.filter((d) => d.status === "validated").length;
  const hasSomeAccepted = acceptedCount > 0 && acceptedCount < drafts.length;

  /** Accept the current card, then auto-advance to the next undecided one (spec footer
   * "Accept … then auto-advances to the next undecided card"). */
  function acceptCurrent() {
    if (!current || !auth.can) return;
    onAccept(current.id);
    const statuses = drafts.map((d) => (d.id === current.id ? "validated" : d.status));
    const next = nextUndecidedIndex(statuses, clamped);
    if (next !== null && next !== clamped) {
      setRestoreId(null);
      setDirection(next >= clamped ? "right" : "left");
      setIndex(next);
    }
  }

  /** First click arms the current card (auto-disarms after 8s); a second click on the
   * same armed card actually discards it. Branches on `armedRef`, not the `armedDiscard`
   * state, so two clicks arriving before a render commits still see the true current
   * arm state instead of both reading the same stale (pre-arm) value. */
  function discardCurrent() {
    if (!current || !auth.can) return;
    if (armedRef.current !== current.id) {
      armedRef.current = current.id;
      setArmedDiscard(current.id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => {
        armedRef.current = null;
        setArmedDiscard(null);
      }, 8000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    armedRef.current = null;
    setArmedDiscard(null);
    setDiscarding(true);
    void Promise.resolve(onDiscard(current.id)).finally(() => setDiscarding(false));
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (drafts.length === 0) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(1);
          break;
        case "a":
          if (current) {
            e.preventDefault();
            acceptCurrent();
          }
          break;
        case "d":
          e.preventDefault();
          discardCurrent();
          break;
        case "/":
          e.preventDefault();
          feedbackRef.current?.focus();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, drafts.length, armedDiscard, auth.can]);

  if (drafts.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" data-draft-deck>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg" data-deck-position>
          {/* The list has no current card: it counts what is decided, which an accept there
              moves on (#174: "Reviewing 1 of 14" stood still). */}
          {view === "list" ? `${acceptedCount} of ${drafts.length} accepted` : `Reviewing ${clamped + 1} of ${drafts.length}`}
        </span>
        <div className="flex items-center gap-1" role="tablist" aria-label="Jump to draft">
          {drafts.map((d, i) => {
            const revising = pendingIds.has(d.id);
            const state = revising ? "revising" : dotState(d.status);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => jump(i)}
                aria-label={`Go to draft ${i + 1}: ${d.name}`}
                aria-current={i === clamped}
                data-deck-dot={d.id}
                data-deck-dot-state={state}
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border transition-colors",
                  i === clamped && "ring-2 ring-primary/60 ring-offset-1 ring-offset-panel",
                  state === "accepted"
                    ? "border-success bg-success text-white"
                    : state === "revising"
                      ? "border-primary bg-primary animate-pulse"
                      : "border-muted bg-transparent hover:border-fg",
                )}
              >
                {state === "accepted" ? (
                  <Check aria-hidden className="size-3 stroke-[3]" />
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Gated auth={auth}>
            <Button size="sm" onClick={onAcceptAll} disabled={!auth.can} data-accept-all>
              <Check /> Accept all
            </Button>
          </Gated>
          {hasSomeAccepted ? (
            <Gated auth={auth}>
              <Button size="sm" onClick={onAcceptRemaining} disabled={!auth.can} data-accept-remaining>
                Accept remaining
              </Button>
            </Gated>
          ) : null}
          <div className="flex items-center rounded-md border border-border p-0.5" data-deck-view={view}>
            <button
              type="button"
              onClick={() => setView("cards")}
              aria-pressed={view === "cards"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-xs",
                view === "cards" ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              <LayoutPanelTop className="size-3.5" /> Cards
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-xs",
                view === "list" ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              <LayoutList className="size-3.5" /> List
            </button>
          </div>
        </div>
      </div>

      {view === "list" ? (
        <DraftList
          drafts={drafts}
          pendingIds={pendingIds}
          onJump={(i) => {
            jump(i);
            setView("cards");
          }}
          // Accepting the current card there advances it as in Cards, so going back to Cards
          // opens on the next undecided draft rather than one already accepted.
          onAccept={(id) => (id === currentId ? acceptCurrent() : onAccept(id))}
          onDiscard={onDiscard}
          discardLabel={discardLabel}
          notes={notes}
          tags={tags}
          editHref={editHref}
          auth={auth}
        />
      ) : current ? (
        <>
          <div
            key={current.id}
            className={direction === "left" ? "animate-deck-slide-left" : "animate-deck-slide-right"}
          >
            <DraftCard
              scenario={current}
              revising={pendingIds.has(current.id)}
              reviseError={errors.get(current.id)}
              justUpdated={isFlashing(current.id)}
              feedback={feedbackDrafts.get(current.id) ?? ""}
              onFeedbackChange={(value) => onFeedbackChange(current.id, value)}
              onRevise={() => onRevise(current.id)}
              feedbackInputRef={feedbackRef}
              note={notes?.get(current.id) ?? null}
              tag={tags?.get(current.id) ?? null}
              editHref={editHref ? editHref(current.id) : null}
              multiPlatform={drafts.some((d) => d.target_kind)}
              evidence={evidence?.get(current.id)}
              previous={versions?.get(current.id) ?? null}
              auth={auth}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={() => go(-1)} data-deck-prev>
              <ChevronLeft /> Previous <kbd className="ml-1 text-[10px] opacity-60 max-sm:hidden">←</kbd>
            </Button>
            <Gated auth={auth}>
              <Button
                size="sm"
                variant="danger"
                onClick={discardCurrent}
                disabled={!auth.can}
                loading={discarding}
                title={
                  armedDiscard === current.id
                    ? "Click again to confirm"
                    : "Discard this draft"
                }
                data-draft-discard
                data-draft-discard-armed={armedDiscard === current.id ? "true" : undefined}
              >
                <Trash2 />
                {armedDiscard === current.id ? "Click to confirm" : discardLabel}
                {armedDiscard === current.id ? null : (
                  <kbd className="ml-1 text-[10px] opacity-60 max-sm:hidden">d</kbd>
                )}
              </Button>
            </Gated>
            <Gated auth={auth}>
              <Button
                size="sm"
                variant="primary"
                onClick={acceptCurrent}
                disabled={!auth.can || current.status === "validated"}
                data-draft-accept
              >
                <Check /> Accept <kbd className="ml-1 text-[10px] opacity-60 max-sm:hidden">a</kbd>
              </Button>
            </Gated>
            <Button size="sm" onClick={() => go(1)} className="ml-auto" data-deck-next>
              Next <ChevronRight /> <kbd className="ml-1 text-[10px] opacity-60 max-sm:hidden">→</kbd>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
