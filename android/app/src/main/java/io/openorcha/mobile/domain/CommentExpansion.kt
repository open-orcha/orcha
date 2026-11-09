package io.openorcha.mobile.domain

/** GH #378: the Show more / Show less rules every long mobile comment follows (iOS `CommentExpansion`). */
object CommentExpansion {
    /** Collapsed comments show this many lines everywhere (Activity, verification Result). */
    const val COLLAPSED_LINES = 6

    /** The control appears only when the collapsed text really overflowed, and stays while expanded so it can collapse. */
    fun showsControl(overflowed: Boolean, expanded: Boolean): Boolean = overflowed || expanded

    /** Expanded comments are tracked by id, so a recycled row never inherits another comment's state. */
    fun toggled(expandedIds: Set<String>, id: String): Set<String> =
        if (id in expandedIds) expandedIds - id else expandedIds + id

    fun controlLabel(expanded: Boolean): String = if (expanded) "Show less" else "Show more"

    /** What TalkBack announces as the control's state. */
    fun stateDescription(expanded: Boolean): String = if (expanded) "Expanded" else "Collapsed"

    /** What TalkBack says a double-tap will do. */
    fun actionLabel(expanded: Boolean): String = if (expanded) "Collapse comment" else "Expand comment"
}
