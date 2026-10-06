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
import type { Agent } from "../../types";
import { anchorLabel, kindLabel, type CodeThreadSummary } from "./codespaceTypes";
import { KindChip, ThreadAuthorAvatar, ThreadStatusIcon } from "./threadBits";

// V2 (D7/D10): Linear Inbox rows — round author avatar, the opening message
// as the bold line, ONE muted meta line (kind · path:lines · @author), and
// the status glyph over the age on the right. Two text lines max.
export function RecentThreadsList({
  threads,
  agents,
  onOpen,
  emptyLabel = "No threads yet.",
}: {
  threads: CodeThreadSummary[];
  agents?: Agent[];
  onOpen?: (thread: CodeThreadSummary) => void;
  emptyLabel?: string;
}) {
  if (!threads.length) return <div className="cs-empty-line">{emptyLabel}</div>;
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
          <span className="cs-recent-glyph">
            <ThreadAuthorAvatar alias={t.created_by_alias} id={t.created_by_agent_id} kind={t.kind} agents={agents} />
          </span>
          <div className="cs-recent-body">
            <div className="cs-recent-snippet">{trunc(t.first_message, 120) || kindLabel(t.kind)}</div>
            <div className="cs-recent-meta">
              <KindChip kind={t.kind} />
              <span className="cs-recent-loc mono" title={t.path}>{t.path}:{anchorLabel(t.start_line, t.end_line)}</span>
              {t.created_by_alias ? <span className="cs-recent-author">@{t.created_by_alias}</span> : null}
            </div>
          </div>
          <div className="cs-recent-side">
            <ThreadStatusIcon status={t.status} />
            <span className="cs-recent-time">{relTime(t.updated_at || t.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
