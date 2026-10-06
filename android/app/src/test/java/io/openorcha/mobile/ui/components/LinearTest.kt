package io.openorcha.mobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.theme.OrchaLinearDarkPalette
import io.openorcha.mobile.ui.theme.OrchaLinearLightPalette
import io.openorcha.mobile.ui.theme.OrchaSwissDarkPalette
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Pure-logic coverage for the Linear kit (`Linear.kt`) — mirrors iOS `LinearTests`. */
class LinearTest {

    @Test
    fun priorityBucketsMatchTheWeb() {
        assertEquals("No priority", priorityLabel(null))
        assertEquals("Urgent", priorityLabel(0))
        assertEquals("Urgent", priorityLabel(5))
        assertEquals("High", priorityLabel(6))
        assertEquals("High", priorityLabel(20))
        assertEquals("Normal", priorityLabel(21))
        assertEquals("Normal", priorityLabel(100))
        assertEquals("Low", priorityLabel(101))
        assertEquals(4, lPriorityLevel(1))
        assertEquals(0, lPriorityLevel(null))
    }

    @Test
    fun priorityBarsLitByLevel() {
        assertEquals(1, levelBars(1))
        assertEquals(2, levelBars(2))
        assertEquals(3, levelBars(3))
    }

    private fun style(k: LStatusKind, t: LStatusTone) = k to t

    @Test
    fun taskStatusesMatchTheWebStatusIcon() {
        assertEquals(style(LStatusKind.Todo, LStatusTone.Todo), lStatusStyle("ready"))
        assertEquals(style(LStatusKind.Dashed, LStatusTone.Todo), lStatusStyle("pending"))
        assertEquals(style(LStatusKind.Progress, LStatusTone.Progress), lStatusStyle("in_progress"))
        assertEquals(style(LStatusKind.Progress, LStatusTone.Progress), lStatusStyle("IN_PROGRESS"))
        assertEquals(style(LStatusKind.Review, LStatusTone.Review), lStatusStyle("needs_verification"))
        assertEquals(style(LStatusKind.Done, LStatusTone.Done), lStatusStyle("completed"))
        assertEquals(style(LStatusKind.Blocked, LStatusTone.Danger), lStatusStyle("blocked"))
        assertEquals(style(LStatusKind.Failed, LStatusTone.Danger), lStatusStyle("failed"))
        assertEquals(style(LStatusKind.Cancelled, LStatusTone.Muted), lStatusStyle("cancelled"))
        assertEquals(style(LStatusKind.Dashed, LStatusTone.Todo), lStatusStyle("not_ready"))
    }

    @Test
    fun requestStatusesMatchTheWebStatusIcon() {
        assertEquals(style(LStatusKind.Open, LStatusTone.Todo), lStatusStyle(requestGlyphStatus("open")))
        assertEquals(style(LStatusKind.Accepted, LStatusTone.Accent), lStatusStyle(requestGlyphStatus("accepted")))
        assertEquals(style(LStatusKind.Done, LStatusTone.Done), lStatusStyle(requestGlyphStatus("answered")))
        assertEquals(style(LStatusKind.Closed, LStatusTone.Muted), lStatusStyle(requestGlyphStatus("closed")))
        assertEquals(style(LStatusKind.Rejected, LStatusTone.Danger), lStatusStyle(requestGlyphStatus("rejected")))
        assertEquals(style(LStatusKind.Escalated, LStatusTone.Danger), lStatusStyle(requestGlyphStatus("escalated")))
        assertEquals(style(LStatusKind.Converted, LStatusTone.Accent), lStatusStyle(requestGlyphStatus("converted_to_task")))
    }

    @Test
    fun agentStatusesMatchTheWebStatusIcon() {
        assertEquals(style(LStatusKind.Progress, LStatusTone.Progress), lStatusStyle("working"))
        assertEquals(style(LStatusKind.Dotted, LStatusTone.Faint), lStatusStyle("idle"))
        assertEquals(style(LStatusKind.Dotted, LStatusTone.Faint), lStatusStyle("offline"))
        assertEquals(style(LStatusKind.Paused, LStatusTone.Warn), lStatusStyle("awaiting_request"))
        assertEquals(style(LStatusKind.Attention, LStatusTone.Warn), lStatusStyle("awaiting_human"))
        assertEquals(style(LStatusKind.Stopped, LStatusTone.Danger), lStatusStyle("terminated"))
        assertEquals(style(LStatusKind.Stopped, LStatusTone.Muted), lStatusStyle("orphaned"))
        assertEquals(style(LStatusKind.Paused, LStatusTone.Warn), lStatusStyle("paused"))
        assertEquals(style(LStatusKind.Paused, LStatusTone.Warn), lStatusStyle("rate_limited"))
    }

    @Test
    fun unknownStatusesFallBackToTheFaintRingAndRawLabel() {
        assertEquals(style(LStatusKind.Unknown, LStatusTone.Faint), lStatusStyle("something_new"))
        assertEquals("something_new", lStatusLabel("something_new"))
        assertEquals("unknown", lStatusLabel(""))
    }

    @Test
    fun labelsAreTheWebStatLabels() {
        val expected = mapOf(
            "in_progress" to "In progress", "working" to "Working", "ready" to "Ready", "pending" to "Pending",
            "awaiting_request" to "Waiting", "awaiting_human" to "Needs human",
            "needs_verification" to "Needs verification", "completed" to "Completed",
            "answered" to "Answered", "closed" to "Closed", "rejected" to "Rejected",
            "escalated" to "Escalated", "accepted" to "Accepted", "converted_to_task" to "Converted",
            "terminated" to "Terminated", "not_ready" to "On hold", "rate_limited" to "Rate limited",
        )
        for ((status, label) in expected) assertEquals(label, lStatusLabel(status), status)
    }

    @Test
    fun avatarHueIsDeterministicAndMatchesIosDjb2() {
        assertEquals(355f / 360f, lAvatarHue("alice"))
        assertEquals(355f / 360f, lAvatarHue("ALICE"))
        assertEquals(259f / 360f, lAvatarHue("Claude"))
        assertEquals(341f / 360f, lAvatarHue(""))
        for (n in listOf("a", "bob", "agent-42", "✦ unicode")) {
            val h = lAvatarHue(n)
            assertTrue(h in 0f..1f)
            assertEquals(h, lAvatarHue(n))
        }
    }

    @Test
    fun avatarInitialAndPresence() {
        assertEquals("A", avatarInitial("  alice"))
        assertEquals("?", avatarInitial("   "))
        assertEquals(null, presenceKind(null))
        assertEquals(null, presenceKind(""))
        assertEquals(0, presenceKind("working"))
        assertEquals(1, presenceKind("awaiting_request"))
        assertEquals(3, presenceKind("idle"))
        assertEquals(2, presenceKind("blocked"))
        assertEquals(3, presenceKind("terminated"))
    }

    @Test
    fun typeScaleMatchesTheContract() {
        fun check(t: LType, size: Float, weight: FontWeight) {
            val s = ltypeStyle(t)
            assertEquals(size.sp, s.fontSize, "$t size")
            assertEquals(weight, s.fontWeight, "$t weight")
        }
        check(LType.Display, 26f, FontWeight.SemiBold)
        check(LType.Title, 20f, FontWeight.SemiBold)
        check(LType.Headline, 16f, FontWeight.SemiBold)
        check(LType.Body, 15f, FontWeight.Normal)
        check(LType.BodyEmph, 15f, FontWeight.Medium)
        check(LType.Meta, 13f, FontWeight.Normal)
        check(LType.Mono, 12f, FontWeight.Normal)
        check(LType.Micro, 11f, FontWeight.Medium)
        assertEquals(FontFamily.Monospace, ltypeStyle(LType.Mono).fontFamily)
    }

    @Test
    fun primaryFillUsesTheIndigoFillOnLinearAndAccentElsewhere() {
        assertEquals(Color(0xFF5E6AD2), OrchaLinearDarkPalette.lPrimaryFill)
        assertEquals(Color.White, OrchaLinearDarkPalette.lPrimaryText)
        assertEquals(Color(0xFF5E6AD2), OrchaLinearLightPalette.lPrimaryFill)
        assertEquals(OrchaSwissDarkPalette.accent, OrchaSwissDarkPalette.lPrimaryFill)
        assertEquals(OrchaSwissDarkPalette.accentInk, OrchaSwissDarkPalette.lPrimaryText)
    }
}
