package io.openorcha.mobile.domain

import io.openorcha.mobile.data.WorkflowAvailableActionDto
import io.openorcha.mobile.data.WorkflowCapabilityDto
import io.openorcha.mobile.data.WorkflowDetailDto
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
}
