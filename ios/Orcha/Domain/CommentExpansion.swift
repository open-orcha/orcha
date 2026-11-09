import Foundation

/// GH #378: the Show more / Show less rules every long mobile comment follows (Android `CommentExpansion`).
enum CommentExpansion {
    /// Collapsed comments show this many lines everywhere (Activity, verification Result).
    static let collapsedLines = 6

    /// The control appears only when the collapsed text really overflowed, and stays while expanded so it can collapse.
    static func showsControl(overflowed: Bool, expanded: Bool) -> Bool { overflowed || expanded }

    /// Overflow is a measured fact: the text's natural height exceeds its height at the line cap.
    static func overflowed(fullHeight: CGFloat, cappedHeight: CGFloat) -> Bool { fullHeight > cappedHeight + 0.5 }

    /// Expanded comments are tracked by id, so a recycled row never inherits another comment's state.
    static func toggled(_ expandedIds: Set<String>, _ id: String) -> Set<String> {
        var next = expandedIds
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        return next
    }

    /// The task page's scroll view, so a comment can tell when its top has scrolled out of sight.
    static let scrollSpace = "task-detail-scroll"

    /// Collapsing a comment whose top is above the visible area scrolls back to it, so the reader is not
    /// left further down the page (Android brings the comment into view the same way).
    static func revealsOnCollapse(expanded: Bool, topY: CGFloat) -> Bool { expanded && topY < 0 }

    /// Where a scroll view must move so text whose top sits at `textTop` (content coordinates) is back in
    /// sight just under the visible top edge, or nil when that top is already visible. Used by Show less on
    /// screens that do not wire their own scroll-back, so collapsing never strands the reader further down.
    static func revealOffset(textTop: CGFloat, contentOffsetY: CGFloat, insetTop: CGFloat,
                             margin: CGFloat = 8) -> CGFloat? {
        let visibleTop = contentOffsetY + insetTop
        guard textTop < visibleTop - 0.5 else { return nil }
        return max(textTop - margin - insetTop, -insetTop)
    }

    /// The scroll anchor for an Activity row.
    static func rowAnchor(_ id: String) -> String { "activity-\(id)" }

    /// Scroll anchor for the verification card's Result.
    static let resultAnchor = "verification-result"

    static func controlLabel(expanded: Bool) -> String { expanded ? "Show less" : "Show more" }

    /// Label while Show more is fetching the complete comment.
    static let loadingLabel = "Loading…"

    /// Shown under a Home update whose complete comment could not be fetched.
    static let loadFailedNote = "Couldn't load the full comment. Tap the update to read it."

    /// The task list (Home's Updates) carries only the first 140 characters of a task's latest comment
    /// (`task_list_query.py`, `LEFT(m.body, 140)`).
    static let summaryCutChars = 140

    /// True when a summary body may be that shortened copy, so Show more must fetch the complete comment
    /// first (GH #378: never present a shortened copy as the whole comment). Counted in Unicode scalars,
    /// as the server counts characters.
    static func summaryMayBeCut(_ body: String) -> Bool { body.unicodeScalars.count >= summaryCutChars }

    /// The complete comment for a cut summary: the task's newest message, when it is the one the summary
    /// was cut from. A newer message (the summary is stale) or none gives nil, so nothing wrong is shown.
    static func completeBody(summary: String, newest: String?) -> String? {
        guard let newest, newest.unicodeScalars.starts(with: summary.unicodeScalars) else { return nil }
        return newest
    }

    /// What VoiceOver reads as the control's value.
    static func stateDescription(expanded: Bool) -> String { expanded ? "Expanded" : "Collapsed" }
}
