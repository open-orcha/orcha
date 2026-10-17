package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentBudgetDto
import io.openorcha.mobile.data.BudgetOverride
import io.openorcha.mobile.data.BudgetUsage
import io.openorcha.mobile.data.TurnDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AgentInsightsTest {

    @Test
    fun workedForLabelMatchesIos() {
        assertNull(AgentInsights.workedForLabel(0.4))
        assertEquals("Worked for 47 sec", AgentInsights.workedForLabel(47.0))
        assertEquals("Worked for 3 min", AgentInsights.workedForLabel(200.0))
        assertEquals("Worked for 1 h 5 min", AgentInsights.workedForLabel(3900.0))
        assertNull(AgentInsights.workedForLabel(7200.0))
    }

    @Test
    fun workedForAttachesToFirstReplyAfterHumanTurn() {
        val turns = listOf(
            TurnDto(seq = 1, role = "human", content = "hi", createdAt = "2026-10-02T10:00:00Z"),
            TurnDto(seq = 2, role = "agent", content = "hello", createdAt = "2026-10-02T10:00:47Z"),
            TurnDto(seq = 3, role = "agent", content = "more", createdAt = "2026-10-02T10:05:00Z"),
            TurnDto(seq = 4, role = "human", content = "next", createdAt = "2026-10-02T11:00:00+00:00"),
            TurnDto(seq = 5, role = "system", content = "note", createdAt = "2026-10-02T11:00:10+00:00"),
            TurnDto(seq = 6, role = "agent", content = "ok", createdAt = "2026-10-02T11:03:00+00:00"),
        )
        val m = AgentInsights.workedFor(turns, humanId = null)
        assertEquals("Worked for 47 sec", m[2])
        assertNull(m[3])
        assertEquals("Worked for 3 min", m[6])
        assertNull(m[5])
    }

    @Test
    fun humanTurnRecognisedByAuthorId() {
        val turns = listOf(
            TurnDto(seq = 1, role = "user", authorAgentId = "me", createdAt = "2026-10-02T10:00:00Z"),
            TurnDto(seq = 2, role = "agent", createdAt = "2026-10-02T10:00:30Z"),
        )
        assertEquals("Worked for 30 sec", AgentInsights.workedFor(turns, "me")[2])
    }

    @Test
    fun budgetFormattingMatchesWeb() {
        assertEquals("$1,234.50", AgentInsights.fmtUsd(1234.5))
        assertEquals("$0.00", AgentInsights.fmtUsd(null))
        assertEquals("1.2M", AgentInsights.fmtTok(1_200_000))
        assertEquals("12M", AgentInsights.fmtTok(12_000_000))
        assertEquals("1.5k", AgentInsights.fmtTok(1_500))
        assertEquals("950", AgentInsights.fmtTok(950))
        assertEquals("42%", AgentInsights.pctLabel(0.42))
        assertEquals(">999%", AgentInsights.pctLabel(12.0))
        assertEquals("", AgentInsights.pctLabel(null))
        assertEquals(1f, AgentInsights.meterFraction(1.4))
        assertEquals(AgentInsights.Tone.Warn, AgentInsights.meterTone(0.85))
        assertEquals(AgentInsights.Tone.Over, AgentInsights.meterTone(1.0))
        assertEquals("Nov 1", AgentInsights.fmtReset("2026-11-01T00:00:00+00:00"))
        assertEquals("October 2026", AgentInsights.fmtPeriod("2026-10"))
    }

    @Test
    fun spendUnknownWhenNothingMetered() {
        assertTrue(AgentInsights.spendUnknown(BudgetUsage(meteredRuns = 0, unmeteredRuns = 2)))
        assertFalse(AgentInsights.spendUnknown(BudgetUsage(meteredRuns = 1, unmeteredRuns = 2)))
    }

    @Test
    fun overrideOnlyForOwnPauseAndNonViewers() {
        val paused = AgentBudgetDto(paused = true, blockedBy = "agent", state = "exceeded")
        assertTrue(AgentInsights.canGrantOverride(paused, "owner"))
        assertTrue(AgentInsights.canGrantOverride(paused, null))
        assertFalse(AgentInsights.canGrantOverride(paused, "viewer"))
        assertFalse(AgentInsights.canGrantOverride(paused.copy(blockedBy = "project"), "owner"))
        assertFalse(AgentInsights.canGrantOverride(paused.copy(override = BudgetOverride(active = true)), "owner"))
        assertFalse(AgentInsights.canGrantOverride(paused.copy(paused = false), "owner"))
        assertEquals("Paused for new runs — project budget reached", AgentInsights.pausedTitle(paused.copy(blockedBy = "project")))
    }

    @Test
    fun imagePreviewDetection() {
        assertTrue(AgentInsights.isPreviewableImage("assets/Logo.PNG"))
        assertTrue(AgentInsights.isPreviewableImage("a/b.webp"))
        assertFalse(AgentInsights.isPreviewableImage("icon.svg"))
        assertFalse(AgentInsights.isPreviewableImage("Makefile"))
        assertFalse(AgentInsights.isPreviewableImage(null))
        assertEquals("Added", AgentInsights.changeStatusLabel("??"))
        assertEquals("Deleted", AgentInsights.changeStatusLabel("D"))
    }

    @Test
    fun elapsedLabel() {
        assertEquals("12s", AgentInsights.elapsedLabel(12))
        assertEquals("2m 5s", AgentInsights.elapsedLabel(125))
        assertEquals("1h 1m", AgentInsights.elapsedLabel(3660))
    }
}
