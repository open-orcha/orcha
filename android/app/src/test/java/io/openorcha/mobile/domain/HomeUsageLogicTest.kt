package io.openorcha.mobile.domain

import io.openorcha.mobile.data.MxDayDto
import io.openorcha.mobile.data.MxTotalsDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeUsageLogicTest {
    private val reported = MxTotalsDto(runs = 67, estCostUsd = 53.632, runsWithCost = 60)
    private val unreported = MxTotalsDto(runs = 5, estCostUsd = 0.0, runsWithCost = 0)

    @Test fun costHeadlineFormatsUsd() = assertEquals("$53.63", HomeUsage.costHeadline(reported))

    @Test fun costHeadlineNeverFakesZero() = assertEquals("Not reported", HomeUsage.costHeadline(unreported))

    @Test fun runsCaptionPluralises() {
        assertEquals("67 runs", HomeUsage.runsCaption(reported))
        assertEquals("1 run", HomeUsage.runsCaption(MxTotalsDto(runs = 1)))
    }

    @Test fun accessibilityLabelReadsTheCard() {
        assertEquals("Usage this week: $53.63, 67 runs. Opens Metrics and usage.", HomeUsage.accessibilityLabel(reported))
        assertEquals("Usage this week: cost not reported, 5 runs. Opens Metrics and usage.", HomeUsage.accessibilityLabel(unreported))
        assertEquals("No runs this week. Opens Metrics and usage.", HomeUsage.accessibilityLabel(null))
        assertEquals("No runs this week. Opens Metrics and usage.", HomeUsage.accessibilityLabel(MxTotalsDto()))
    }

    @Test fun sparklineScalesToPeakAndFlagsIt() {
        val days = listOf(2, 0, 8, 4, 8, 1, 0).mapIndexed { i, r -> MxDayDto(date = "2026-09-2${i}", runs = r) }
        val bars = HomeUsage.sparkline(days)
        assertEquals(listOf(0.25f, 0f, 1f, 0.5f, 1f, 0.125f, 0f), bars.map { it.fraction })
        assertEquals(listOf(2), bars.withIndex().filter { it.value.peak }.map { it.index })
    }

    @Test fun sparklinePadsShortWindowsAndSortsByDate() {
        val bars = HomeUsage.sparkline(listOf(MxDayDto("2026-09-30", 3), MxDayDto("2026-09-29", 6)))
        assertEquals(7, bars.size)
        assertEquals(listOf(0f, 0f, 0f, 0f, 0f, 1f, 0.5f), bars.map { it.fraction })
        assertTrue(bars[5].peak)
    }

    @Test fun sparklineKeepsLastSevenDays() {
        val days = (1..10).map { MxDayDto(date = "2026-09-%02d".format(it), runs = it) }
        val bars = HomeUsage.sparkline(days)
        assertEquals(7, bars.size)
        assertEquals(0.4f, bars.first().fraction, 0.0001f)
        assertTrue(bars.last().peak)
    }

    @Test fun sparklineAllZeroHasNoPeak() {
        val bars = HomeUsage.sparkline(emptyList())
        assertEquals(7, bars.size)
        assertTrue(bars.all { it.fraction == 0f && !it.peak })
    }
}
