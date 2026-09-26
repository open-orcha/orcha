/**
 * Repo-wide "Recent threads" row list — extracted out of ThreadRail.tsx (was
 * a private RecentList there) so the no-file landing state
 * (CodeSpaceLanding.tsx, item 2) can render the SAME rows, not a
 * reimplementation: ThreadRail's compact quick-jump and the landing page's
 * "Recent threads" card both read off fetchRecentThreads and both open a
 * thread the same way (onNavigateToThread — file + line + thread selected).
 *
 * "Richer rows" (item 2 of the nav build) over the original: a kind label
 * pill (not just the compact glyph) plus the author alias, so a row reads
 * standalone without the glyph legend memorized — still the same card/list
 * idiom (.cs-recent-row) the rail already used, just one more meta line.
 */
import { relTime, trunc } from "../../lib/format";
import { anchorLabel, kindGlyph, kindLabel, type CodeThreadSummary } from "./codespaceTypes";

export function RecentThreadsList({
  threads,
  onOpen,
  emptyLabel = "No threads yet.",
}: {
  threads: CodeThreadSummary[];
  onOpen?: (thread: CodeThreadSummary) => void;
  emptyLabel?: string;
}) {
  if (!threads.length) return <div className="none" style={{ padding: 10 }}>{emptyLabel}</div>;
  return (
    <div className="cs-recent-list">
      {threads.map((t) => (
        <div
          key={t.id}
          className="cs-recent-row"
          onClick={() => onOpen?.(t)}
          role={onOpen ? "button" : undefined}
          tabIndex={onOpen ? 0 : undefined}
          onKeyDown={(e) => {
            if (onOpen && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(t); }
          }}
        >
          <span className="cs-recent-glyph" aria-hidden="true">{kindGlyph(t.kind)}</span>
          <div className="cs-recent-body">
            <div className="cs-recent-loc mono">{t.path}:{anchorLabel(t.start_line, t.end_line)}</div>
            <div className="cs-recent-snippet">{trunc(t.first_message, 60) || kindLabel(t.kind)}</div>
            <div className="cs-recent-meta">
              <span className={"kind-tag " + t.kind}>{kindLabel(t.kind)}</span>
              {t.created_by_alias ? <span className="cs-recent-author">@{t.created_by_alias}</span> : null}
            </div>
          </div>
          <span className="cs-recent-time">{relTime(t.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
