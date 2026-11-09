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
