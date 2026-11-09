import { HelpCircle, Lightbulb, MessageSquareQuote, TrendingUp, UserRound } from "../../map/kit/icons";
import type { LucideIcon } from "../../map/kit/icons";
import { NOTE_KIND_LABELS } from "./exploration";
import type { ExplorationNote, ExplorationNoteKind } from "./types";

const NOTE_ICONS: Record<ExplorationNoteKind, LucideIcon> = {
  impression: MessageSquareQuote,
  usability: UserRound,
  idea: Lightbulb,
  improvement: TrendingUp,
  needs_info: HelpCircle,
};

/**
 * What the agent judged, kept in its own section and given its own visual
 * language — no severity colour, no measurement, no crop outline, a quoted left
 * rule instead of a bordered card.
 *
 * The separation is the point. A reader skimming this page must never have to
 * check a label to know whether they are looking at a number or an opinion; the
 * two read differently from across the room, which is what "visible at a glance,
 * not buried in a label" means.
 */
export function NotesSection({ notes }: { notes: readonly ExplorationNote[] }) {
  if (notes.length === 0) {
    return (
      <div
        className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted"
        data-exploration-notes-empty
      >
        The agent recorded no impressions for this exploration.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5" data-exploration-notes>
      {notes.map((note) => {
        const Icon = NOTE_ICONS[note.kind] ?? MessageSquareQuote;
        return (
          <li
            key={note.id}
            data-exploration-note={note.id}
            data-note-kind={note.kind}
            className="flex gap-3 py-0.5"
          >
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
              <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h4 className="text-sm font-medium leading-snug text-fg">{note.title}</h4>
                <span className="text-sm text-muted">
                  {NOTE_KIND_LABELS[note.kind] ?? note.kind}
                </span>
              </div>
              {note.body ? (
                <p className="text-sm leading-snug text-muted">{note.body}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
