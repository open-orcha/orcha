package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TaskMessageDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** GH #378: the Show more / Show less rules (iOS `CommentExpansionRuleTests`). */
class CommentExpansionTest {
    @Test fun controlOnlyWhenOverflowedOrExpanded() {
        assertFalse(CommentExpansion.showsControl(overflowed = false, expanded = false))
        assertTrue(CommentExpansion.showsControl(overflowed = true, expanded = false))
        assertTrue(CommentExpansion.showsControl(overflowed = false, expanded = true))
    }

    /** QA round 1: Home's summary is the server's first 140 characters, so Show more must fetch the rest. */
    @Test fun homeSummaryAtTheServerCutIsTreatedAsCut() {
        val long = "I traced the stall to the notifier scan loop and moved the inventory to a background pass. ".repeat(8)
        assertFalse(CommentExpansion.summaryMayBeCut("Pushed the fix. Tests are green."))
        assertTrue(CommentExpansion.summaryMayBeCut(long.take(140)))
        assertFalse(CommentExpansion.summaryMayBeCut(long.take(139)))
        // The server counts characters (code points): 140 emoji are 280 UTF-16 units but 140 characters.
        assertTrue(CommentExpansion.summaryMayBeCut("😀".repeat(140)))
        assertFalse(CommentExpansion.summaryMayBeCut("😀".repeat(70)))
    }

    private val full = "I traced the stall to the notifier scan loop and moved the inventory to a background pass. ".repeat(8)

    private fun comment(
        body: String,
        by: String = "Original author",
        at: String = "2026-11-09T12:00:00.673000+00:00",
        human: Boolean = false,
    ) = TaskMessageDto(messageId = "m", authorAlias = by, isHuman = human, body = body, createdAt = at)

    @Test fun completeBodyIsTheNewestMessageOnlyWhenItContinuesTheSummary() {
        val summary = comment(full.take(140))
        assertEquals(full, CommentExpansion.completeBody(summary, comment(full)))
        assertEquals(null, CommentExpansion.completeBody(summary, comment("A newer comment")))
        assertEquals(null, CommentExpansion.completeBody(summary, null))
    }

    /** Review round 6: a newer comment that opens with the same 140 characters must not expand under the
     *  old author and time. */
    @Test fun newerCommentWithTheSamePrefixIsNotTheSummarysComment() {
        val summary = comment(full.take(140))
        val newer = summary.body + " NEWER COMMENT END"
        assertEquals(null, CommentExpansion.completeBody(summary, comment(newer, at = "2026-11-09T12:01:00Z")))
        assertEquals(null, CommentExpansion.completeBody(summary, comment(newer, by = "Someone else")))
        assertEquals(null, CommentExpansion.completeBody(summary, comment(newer, human = true)))
        assertEquals(null, CommentExpansion.completeBody(comment(summary.body, at = ""), comment(newer, at = "")))
    }

    /** The same time written two ways (Postgres trims the fraction's zeros, the thread keeps six digits). */
    @Test fun sameCommentMatchesTheSameInstantInEitherFormat() {
        val summary = comment(full.take(140), at = "2026-11-09T12:00:00.673+00:00")
        assertEquals(full, CommentExpansion.completeBody(summary, comment(full, at = "2026-11-09T12:00:00.673000+00:00")))
        assertTrue(CommentExpansion.isSameComment(comment("x", at = "2026-11-09T12:00:00Z"), comment("x", at = "2026-11-09T12:00:00.000000+00:00")))
        assertTrue(CommentExpansion.isSameComment(comment("x", at = "2026-11-09T12:00:00"), comment("x", at = "2026-11-09T12:00:00+00:00")))
    }

    @Test fun toggleIsPerCommentId() {
        var open = emptySet<String>()
        open = CommentExpansion.toggled(open, "a")
        open = CommentExpansion.toggled(open, "b")
        open = CommentExpansion.toggled(open, "a")
        assertEquals(setOf("b"), open)
    }

    @Test fun labelsAndAnnouncedState() {
        assertEquals("Show more", CommentExpansion.controlLabel(false))
        assertEquals("Show less", CommentExpansion.controlLabel(true))
        assertEquals("Collapsed", CommentExpansion.stateDescription(false))
        assertEquals("Expanded", CommentExpansion.stateDescription(true))
        assertEquals(6, CommentExpansion.COLLAPSED_LINES)
    }
}
