package io.openorcha.mobile.domain

import io.openorcha.mobile.data.ImportTaskImpactDto
import io.openorcha.mobile.data.WorkflowAvailableActionDto
import io.openorcha.mobile.data.WorkflowCapabilityDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowPreviewDto
import io.openorcha.mobile.domain.WorkflowLogic.MenuAction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WorkflowLogicTest {
    private val writable = WorkflowCapabilityDto(workflowHumanWrite = true)

    private fun wf(vararg enabled: String, hidden: Boolean = false, disabled: Map<String, String> = emptyMap()) = WorkflowDetailDto(
        id = "w1",
        capability = writable,
        hidden = hidden,
        availableActions = enabled.map { WorkflowAvailableActionDto(it, enabled = true) } +
            disabled.map { (a, r) -> WorkflowAvailableActionDto(a, enabled = false, reason = r) },
    )

    @Test fun primaryIsStartWhenStartIsEnabled() =
        assertEquals(MenuAction.Start, WorkflowLogic.primaryAction(wf("start", "resume"), hasHuman = true))

    @Test fun primaryFallsBackToResumeThenFinish() {
        assertEquals(MenuAction.Resume, WorkflowLogic.primaryAction(wf("resume"), hasHuman = true))
        assertEquals(MenuAction.Finish, WorkflowLogic.primaryAction(wf("pause"), hasHuman = true))
    }

    @Test fun primaryIsFinishWithoutAHuman() =
        assertEquals(MenuAction.Finish, WorkflowLogic.primaryAction(wf("start"), hasHuman = false))

    @Test fun overflowDropsThePrimaryAndKeepsWebOrder() {
        val items = WorkflowLogic.overflow(wf("start"), hasHuman = true)
        assertFalse(MenuAction.Start in items)
        assertEquals(MenuAction.Pause, items.first())
        assertEquals(MenuAction.Cancel, items.last())
    }

    @Test fun overflowNeverStartsOrEndsWithASeparator() {
        listOf(wf("start"), wf("resume"), wf()).forEach { w ->
            val items = WorkflowLogic.overflow(w, hasHuman = true)
            assertTrue(items.first() != null && items.last() != null)
            assertFalse(items.zipWithNext().any { (a, b) -> a == null && b == null })
        }
    }

    @Test fun hiddenWorkflowRefusesEverythingButRestore() {
        val w = wf("pause", "restore", hidden = true)
        assertEquals("Restore this hidden workflow before making changes.", WorkflowLogic.actionReason(w, "pause", true))
        assertNull(WorkflowLogic.actionReason(w, "restore", true))
    }

    @Test fun hideIsUnavailableWhenTheServerDoesNotOfferIt() =
        assertEquals("Hiding workflows is not available on this server.", WorkflowLogic.menuReason(wf("pause"), MenuAction.Hide, true))

    @Test fun settingsIsEnabledWhenEitherPatchOrTransferIs() {
        assertNull(WorkflowLogic.menuReason(wf("transfer_owner"), MenuAction.Settings, true))
        assertTrue(WorkflowLogic.menuReason(wf(), MenuAction.Settings, true) != null)
    }

    @Test fun writeReasonExplainsMissingIntegration() {
        val cap = WorkflowCapabilityDto(workflowHumanWrite = false, reason = "integration_required")
        assertEquals(
            "Workflow changes are not available on this server yet. You can continue reading.",
            WorkflowLogic.writeReason(cap, hasHuman = true),
        )
        assertNull(WorkflowLogic.writeReason(writable, hasHuman = true))
    }

    @Test fun disabledActionWithoutKnownReasonGetsGenericCopy() {
        val reason = WorkflowLogic.actionReason(wf(disabled = mapOf("cancel" to "some_new_reason")), "cancel", true)
        assertTrue(!reason.isNullOrBlank())
    }

    @Test fun modeLabels() {
        assertEquals("Parallel", WorkflowLogic.modeLabel("parallel"))
        assertEquals("Serial", WorkflowLogic.modeLabel("serial"))
    }

    @Test fun plural() {
        assertEquals("1 task", WorkflowLogic.plural(1, "task"))
        assertEquals("3 tasks", WorkflowLogic.plural(3, "task"))
    }

    @Test fun modeChangeNeedsPauseOnceStarted() {
        val running = WorkflowDetailDto(launchEnabled = true, status = "active", executionMode = "serial")
        assertEquals(
            "Pause new starts and wait for current turns before changing how work runs.",
            WorkflowLogic.modeChangeReason(running, "parallel"),
        )
        assertNull(WorkflowLogic.modeChangeReason(running, "serial"))
        assertNull(WorkflowLogic.modeChangeReason(running.copy(status = "paused"), "parallel"))
        assertNull(WorkflowLogic.modeChangeReason(running.copy(launchEnabled = false), "parallel"))
    }

    @Test fun settingsNeedReasonAndTurnAllowanceOnlyForLoops() {
        val v1 = WorkflowDetailDto(semanticsVersion = 1)
        val v2 = WorkflowDetailDto(semanticsVersion = 2)
        assertEquals("Give the workflow a name, goal and reason for the change.", WorkflowLogic.settingsInvalid(v1, "T", "G", " ", listOf("3", "2"), "40"))
        assertNull(WorkflowLogic.settingsInvalid(v1, "T", "G", "why", listOf("3", "2"), ""))
        assertEquals("Enter positive whole-number limits.", WorkflowLogic.settingsInvalid(v2, "T", "G", "why", listOf("3", "2"), "0"))
        assertEquals("The agent-turn allowance can be at most 1000.", WorkflowLogic.settingsInvalid(v2, "T", "G", "why", listOf("3", "2"), "1001"))
    }

    private val finished = ImportTaskImpactDto(
        id = "t1", title = "Spec", status = "completed", eligible = true, requiresAcceptance = true,
        resultDigest = "a".repeat(64), resultText = "done", definitionOfDone = "spec written",
    )

    @Test fun importAcceptancePinsTheExactResult() {
        val pv = WorkflowPreviewDto(taskImpacts = listOf(finished))
        val ok = WorkflowLogic.ImportReview(WorkflowLogic.importSource(finished), "meets the spec", accepted = true)
        assertEquals("a".repeat(64), WorkflowLogic.importAcceptances(pv, mapOf("t1" to ok))["t1"]?.reviewedResultDigest)
        assertFalse(WorkflowLogic.missingImportReview(pv, mapOf("t1" to ok)))
        // result changed after review, blank narrative, or not ticked: no acceptance
        val changed = WorkflowPreviewDto(taskImpacts = listOf(finished.copy(resultText = "edited")))
        assertTrue(WorkflowLogic.missingImportReview(changed, mapOf("t1" to ok)))
        assertTrue(WorkflowLogic.missingImportReview(pv, mapOf("t1" to ok.copy(narrative = " "))))
        assertTrue(WorkflowLogic.missingImportReview(pv, mapOf("t1" to ok.copy(accepted = false))))
    }

    @Test fun importBlockedUntilGroupIsWholeAndReviewed() {
        val pv = WorkflowPreviewDto(requiredTaskIds = listOf("t1", "t2"), taskImpacts = listOf(finished))
        assertEquals("Include the whole connected group, then review again.", WorkflowLogic.importBlocked(pv, listOf("t1"), emptyMap(), emptyList()))
        assertEquals(
            "Review and accept each finished result before adding it.",
            WorkflowLogic.importBlocked(pv, listOf("t1", "t2"), emptyMap(), emptyList()),
        )
        val ok = WorkflowLogic.ImportReview(WorkflowLogic.importSource(finished), "meets the spec", accepted = true)
        assertNull(WorkflowLogic.importBlocked(pv, listOf("t1", "t2"), mapOf("t1" to ok), emptyList()))
    }

    @Test fun importChoiceReasonsAndReleaseChoices() {
        assertEquals("Already in this workflow", WorkflowLogic.importChoiceReason("todo", false, null, "t1", listOf("t1")))
        assertEquals("Already in another workflow", WorkflowLogic.importChoiceReason("todo", false, "w2", "t1", emptyList()))
        assertEquals("Wait for the current work and review to end", WorkflowLogic.importChoiceReason("in_progress", false, null, "t1", emptyList()))
        assertEquals("Review its saved result before adding", WorkflowLogic.importChoiceNote("completed", false, null, "t1", emptyList()))
        assertEquals("Will stay held until explicitly released", WorkflowLogic.importChoiceNote("todo", false, null, "t1", emptyList()))
        val pv = WorkflowPreviewDto(taskImpacts = listOf(finished.copy(releasable = true)))
        assertEquals(emptyList(), WorkflowLogic.invalidReleaseIds(listOf("t1"), pv, listOf("t1"), canRelease = true))
        assertEquals(listOf("t1"), WorkflowLogic.invalidReleaseIds(listOf("t1"), pv, listOf("t1"), canRelease = false))
    }
}
