package io.openorcha.mobile.domain

import io.openorcha.mobile.data.PerfCostDto
import io.openorcha.mobile.data.PerfMedianDto
import io.openorcha.mobile.data.PerfRateDto
import io.openorcha.mobile.data.ProjectMemberDto
import io.openorcha.mobile.data.ProjectMembersResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProjectLogicTest {
    private val f = ScheduleForm(time = "08:30")

    @Test
    fun `presets build cron like the web`() {
        assertEquals("30 8 * * *", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Daily)))
        assertEquals("30 8 * * 1-5", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Weekdays)))
        assertEquals("30 8 * * 3", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Weekly, weekday = 3)))
        assertEquals("30 8 15 * *", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Monthly, monthDay = 15)))
        assertEquals("15 * * * *", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Hourly, minute = 15)))
        assertEquals("0 6 * * 1", RoutineSchedule.toCron(f.copy(preset = SchedulePreset.Custom, cron = " 0  6 * * 1 ")))
    }

    @Test
    fun `fromCron reads presets back and falls back to custom`() {
        assertEquals(SchedulePreset.Weekdays, RoutineSchedule.fromCron("0 9 * * 1-5").preset)
        assertEquals("09:00", RoutineSchedule.fromCron("0 9 * * 1-5").time)
        assertEquals(5, RoutineSchedule.fromCron("0 7 * * 5").weekday)
        assertEquals(SchedulePreset.Monthly, RoutineSchedule.fromCron("0 7 3 * *").preset)
        assertEquals(SchedulePreset.Hourly, RoutineSchedule.fromCron("45 * * * *").preset)
        assertEquals(SchedulePreset.Custom, RoutineSchedule.fromCron("*/15 9-17 * * 1-5").preset)
        assertFalse(RoutineSchedule.looksLikeCron("0 9 * *"))
        assertTrue(RoutineSchedule.looksLikeCron("0 9 * * *"))
    }

    @Test
    fun `metrics formatting uses the web wording`() {
        assertEquals("75%", MetricsFormat.rate(PerfRateDto(0.75, 3, 4, true)))
        assertEquals(MetricsFormat.NOT_ENOUGH, MetricsFormat.rate(PerfRateDto(0.5, 1, 2, false)))
        assertEquals("1h 30m", MetricsFormat.duration(PerfMedianDto(5400.0, 4, true)))
        assertEquals("2d", MetricsFormat.duration(PerfMedianDto(172_800.0, 4, true)))
        assertEquals(MetricsFormat.NOT_METERED, MetricsFormat.cost(PerfCostDto(null, 0, 4, false)))
        assertEquals("$1.25", MetricsFormat.cost(PerfCostDto(1.25, 3, 0, true)))
        assertEquals("1.5M", MetricsFormat.tokens(1_500_000))
    }

    @Test
    fun `authority allows owner or grant holder only`() {
        val roster = ProjectMembersResponse(listOf(
            ProjectMemberDto("own", "owner"), ProjectMemberDto("mgr", "member", listOf("manage_autonomy")), ProjectMemberDto("m", "member"),
        ))
        assertTrue(ProjectAuthority.can(roster, "own"))
        assertTrue(ProjectAuthority.can(roster, "mgr"))
        assertFalse(ProjectAuthority.can(roster, "m"))
        assertFalse(ProjectAuthority.isOwner(roster, "mgr"))
        assertFalse(ProjectAuthority.can(roster, null))
        assertTrue(ProjectAuthority.can(null, "anyone"))
    }
}
