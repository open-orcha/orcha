package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TaskMessageDto
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime

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

    /** Label while Show more is fetching the complete comment. */
    const val LOADING_LABEL = "Loading…"

    /** Shown under a Home update whose complete comment could not be fetched. */
    const val LOAD_FAILED_NOTE = "Couldn't load the full comment. Tap the update to read it."

    /** The task list (Home's Updates) carries only the first 140 characters of a task's latest comment
     *  (`task_list_query.py`, `LEFT(m.body, 140)`). */
    const val SUMMARY_CUT_CHARS = 140

    /** True when a summary body may be that shortened copy, so Show more must fetch the complete comment
     *  first (GH #378: never present a shortened copy as the whole comment). Counted in code points, as
     *  the server counts characters. */
    fun summaryMayBeCut(body: String): Boolean = body.codePointCount(0, body.length) >= SUMMARY_CUT_CHARS

    /** The complete comment for a cut summary: the task's newest message, when it is the one the summary
     *  was cut from. A newer message (the summary is stale) or none gives null, so nothing wrong is shown.
     *  A newer comment can open with the same 140 characters, so the text alone is not enough: the author
     *  and posting time must match too, or its ending would appear under the old author and time. */
    fun completeBody(summary: TaskMessageDto, newest: TaskMessageDto?): String? =
        newest?.takeIf { isSameComment(summary, it) && it.body.startsWith(summary.body) }?.body

    /** Same author, same kind of author and same posting time. The summary carries no message id; times are
     *  compared as instants because the task list and the thread may format the same time differently
     *  (Postgres drops trailing zeros from the fraction). */
    fun isSameComment(a: TaskMessageDto, b: TaskMessageDto): Boolean {
        if (a.authorAlias != b.authorAlias || a.isHuman != b.isHuman) return false
        if (!a.createdAt.isNullOrBlank() && a.createdAt == b.createdAt) return true
        val t1 = instant(a.createdAt) ?: return false
        val t2 = instant(b.createdAt) ?: return false
        return Duration.between(t1, t2).abs() < Duration.ofMillis(1)
    }

    private fun instant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(iso + "Z") }.getOrNull()
    }
}
