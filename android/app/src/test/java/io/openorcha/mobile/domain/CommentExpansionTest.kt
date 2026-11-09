package io.openorcha.mobile.domain

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

    @Test fun completeBodyIsTheNewestMessageOnlyWhenItContinuesTheSummary() {
        val full = "I traced the stall to the notifier scan loop and moved the inventory to a background pass. ".repeat(8)
        val summary = full.take(140)
        assertEquals(full, CommentExpansion.completeBody(summary, full))
        assertEquals(null, CommentExpansion.completeBody(summary, "A newer comment"))
        assertEquals(null, CommentExpansion.completeBody(summary, null))
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
