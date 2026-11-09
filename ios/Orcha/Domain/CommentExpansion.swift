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

    /// The scroll anchor for an Activity row.
    static func rowAnchor(_ id: String) -> String { "activity-\(id)" }

    static func controlLabel(expanded: Bool) -> String { expanded ? "Show less" : "Show more" }

    /// What VoiceOver reads as the control's value.
    static func stateDescription(expanded: Bool) -> String { expanded ? "Expanded" : "Collapsed" }
}
