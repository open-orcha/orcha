package io.openorcha.mobile.domain

import io.openorcha.mobile.data.EvidenceSummaryDod
import io.openorcha.mobile.data.EvidenceSummaryDto
import io.openorcha.mobile.data.EvidenceSummaryTests
import io.openorcha.mobile.data.EvidenceTestCounts
import io.openorcha.mobile.data.EvidenceTestInvocation
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.GoalNodeDto
import io.openorcha.mobile.data.ManagerReviewDto
import io.openorcha.mobile.data.ReviewRoutingDto
import io.openorcha.mobile.domain.TaskInsightsUx.Preset
import io.openorcha.mobile.domain.TaskInsightsUx.Tone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TaskInsightsUxTest {
    @Test
    fun summaryMatchesWebLine() {
        val s = EvidenceSummaryDto(
            dod = EvidenceSummaryDod(total = 5, proven = 0, notProven = 2, needsHuman = 3),
            tests = EvidenceSummaryTests(status = "none"),
            riskFlags = 2,
        )
        assertEquals(
            "0/5 DoD items evidenced · no tests ran · 2 risk flags",
            TaskInsightsUx.summaryParts(s, short = false).joinToString(" · ") { it.text },
        )
        assertEquals("0/5 DoD · no tests ran · 2 risks", TaskInsightsUx.summaryParts(s).joinToString(" · ") { it.text })
        assertEquals(Tone.Bad, TaskInsightsUx.summaryParts(s).first().tone)
    }

    @Test
    fun summaryTestsPassing() {
        val s = EvidenceSummaryDto(
            dod = EvidenceSummaryDod(total = 2, proven = 2),
            tests = EvidenceSummaryTests(status = "passed", passed = 42),
        )
        val parts = TaskInsightsUx.summaryParts(s)
        assertEquals(listOf("2/2 DoD", "42 tests passed"), parts.map { it.text })
        assertTrue(parts.all { it.tone == Tone.Ok })
        val failing = EvidenceSummaryDto(tests = EvidenceSummaryTests(status = "failed", passed = 3, failed = 1))
        assertEquals("1 test failing", TaskInsightsUx.summaryParts(failing).single().text)
    }

    @Test
    fun invocationText() {
        val inv = EvidenceTestInvocation("npm test", "npm test", 0, EvidenceTestCounts(passed = 10, failed = 1, skipped = 2), "failed")
        assertEquals("10 passed · 1 failed · 2 skipped" to Tone.Bad, TaskInsightsUx.invocationText(inv))
        assertEquals("exit 3" to Tone.Bad, TaskInsightsUx.invocationText(EvidenceTestInvocation(exitCode = 3, outcome = "exit_failed")))
    }

    @Test
    fun managerReviewLines() {
        assertNull(TaskInsightsUx.managerReviewLine(null))
        assertEquals(
            "Forge (manager) recommends approval: ok" to Tone.Ok,
            TaskInsightsUx.managerReviewLine(ManagerReviewDto(status = "approved", managerAlias = "Forge", reasons = "ok")),
        )
        assertEquals(Tone.Bad, TaskInsightsUx.managerReviewLine(ManagerReviewDto(status = "sent_back"))!!.second)
        assertEquals("via Atlas’s manager", TaskInsightsUx.reviewVia(ReviewRoutingDto("reports_to", 1, "Atlas")))
        assertEquals("via Atlas’s manager chain", TaskInsightsUx.reviewVia(ReviewRoutingDto("reports_to", 2, "Atlas")))
    }

    @Test
    fun cronPresetsMatchWeb() {
        assertEquals("15 * * * *", TaskInsightsUx.toCron(Preset.Hourly, 9, 15))
        assertEquals("30 8 * * *", TaskInsightsUx.toCron(Preset.Daily, 8, 30))
        assertEquals("0 9 * * 1-5", TaskInsightsUx.toCron(Preset.Weekdays, 9, 0))
        assertEquals("0 9 * * 0", TaskInsightsUx.toCron(Preset.Weekly, 9, 0, weekday = 7))
        assertEquals("0 9 28 * *", TaskInsightsUx.toCron(Preset.Monthly, 9, 0, monthDay = 31))
    }

    @Test
    fun goalAncestry() {
        val bare = GoalChainDto(goalChain = listOf(GoalNodeDto("objective", "r", "proj"), GoalNodeDto("task", "t", "me")))
        assertFalse(TaskInsightsUx.hasAncestry(bare))
        val withParent = bare.copy(goalChain = listOf(bare.goalChain[0], GoalNodeDto("parent", "p", "Parent"), bare.goalChain[1]))
        assertTrue(TaskInsightsUx.hasAncestry(withParent))
        assertEquals(listOf("proj", "Parent"), TaskInsightsUx.goalCrumbs(withParent).map(TaskInsightsUx::goalCrumbLabel))
    }

    // GH #378: a cut-off objective crumb can open in full; one that fits has nothing to open.
    @Test
    fun goalCrumbFullOnlyWhenTheObjectiveWasCut() {
        val long = "Ship the mobile apps with every long text readable in full, everywhere it appears"
        val cut = GoalNodeDto("objective", "r", "proj", text = long)
        assertEquals(long, TaskInsightsUx.goalCrumbFull(cut))
        assertTrue(TaskInsightsUx.goalCrumbLabel(cut).endsWith("…"))
        assertEquals(null, TaskInsightsUx.goalCrumbFull(GoalNodeDto("objective", "r", "proj", text = "Short goal")))
        assertEquals(null, TaskInsightsUx.goalCrumbFull(GoalNodeDto("parent", "p", long)))
    }

    // GH #378 review round 4 (iOS finding, Android parity): the crumb is one line, so an objective
    // written on several lines keeps every line, joined by spaces, both shortened and opened.
    @Test
    fun goalCrumbObjectiveWithLineBreaksKeepsEveryLine() {
        val short = GoalNodeDto("objective", "r", "proj", text = "Read the first line\nSECOND LINE SHOULD REMAIN READABLE")
        assertEquals("Read the first line SECOND LINE SHOULD REMAIN READABLE", TaskInsightsUx.goalCrumbLabel(short))
        assertEquals(null, TaskInsightsUx.goalCrumbFull(short))
        val long = GoalNodeDto(
            "objective", "r", "proj",
            text = "Read the first line\nSECOND LINE SHOULD REMAIN READABLE even when we expand a long objective on tap",
        )
        assertEquals(
            "Read the first line SECOND LINE SHOULD REMAIN READABLE even when we expand a long objective on tap",
            TaskInsightsUx.goalCrumbFull(long),
        )
        assertTrue(TaskInsightsUx.goalCrumbLabel(long).endsWith("…"))
        assertTrue('\n' !in TaskInsightsUx.goalCrumbLabel(long))
    }
}
