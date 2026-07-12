package io.openorcha.mobile.domain

import io.openorcha.mobile.data.ActiveRunDto
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.AgentTaskRef
import io.openorcha.mobile.data.ContainerDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class OrchaSelectorsTest {
    @Test
    fun needsYouCountsPlansVerificationsAndHumanRequests() {
        val snapshot = ContainerSnapshot(
            container = ContainerDto(id = "c1", name = "local"),
            agents = listOf(AgentDto(id = "h1", alias = "kedar", kind = "human")),
            tasks = listOf(
                TaskDto(id = "t1", title = "Plan", status = "in_progress", planMessage = TaskMessageDto(body = "plan")),
                TaskDto(id = "t2", title = "Verify", status = "needs_verification"),
                TaskDto(id = "t3", title = "Done", status = "completed"),
            ),
            requests = listOf(
                RequestDto(id = "r1", status = "open", payload = "answer me", targetId = "h1"),
                RequestDto(id = "r2", status = "open", payload = "not mine", targetId = "a1"),
            ),
        )

        val result = OrchaSelectors.needsYou(snapshot)

        assertEquals(1, result.planApprovals.size)
        assertEquals(1, result.verifications.size)
        assertEquals(1, result.requests.size)
        assertEquals(3, result.total)
    }

    @Test
    fun groupsTasksByStatus() {
        val tasks = listOf(
            TaskDto(id = "t1", title = "Done", status = "completed"),
            TaskDto(id = "t2", title = "Working", status = "in_progress"),
            TaskDto(id = "t3", title = "Also working", status = "in_progress"),
        )

        val grouped = OrchaSelectors.tasksByStatus(tasks)

        assertEquals(listOf("in_progress", "completed"), grouped.keys.toList())
        assertEquals(2, grouped.getValue("in_progress").size)
    }

    @Test
    fun nowTaskRefPrefersActiveRunTaskOverStaleCurrentTask() {
        val agent = AgentDto(
            id = "a1",
            alias = "Andrew",
            currentTask = AgentTaskRef(taskId = "stale-t1", title = "Stale task"),
            activeRun = ActiveRunDto(runId = "r1", taskId = "live-t2", taskTitle = "Live task"),
        )

        val result = OrchaSelectors.nowTaskRef(agent)

        assertEquals(AgentTaskRef(taskId = "live-t2", title = "Live task"), result)
    }

    @Test
    fun nowTaskRefIsNullForTaskLessActiveRunEvenWithStaleCurrentTask() {
        // A task-less active run (e.g. a conversation) must not fall back to mixing in the
        // stale current_task's id/title — the run wins entirely, including its absence of a task.
        val agent = AgentDto(
            id = "a1",
            alias = "Andrew",
            currentTask = AgentTaskRef(taskId = "stale-t1", title = "Stale task"),
            activeRun = ActiveRunDto(runId = "r1", taskId = null, taskTitle = null),
        )

        val result = OrchaSelectors.nowTaskRef(agent)

        assertNull(result)
    }

    @Test
    fun nowTaskRefFallsBackToCurrentTaskWhenNoActiveRun() {
        val agent = AgentDto(
            id = "a1",
            alias = "Andrew",
            currentTask = AgentTaskRef(taskId = "t1", title = "Current task"),
            activeRun = null,
        )

        val result = OrchaSelectors.nowTaskRef(agent)

        assertEquals(AgentTaskRef(taskId = "t1", title = "Current task"), result)
    }

    // GH #140: task-ref linkification — bare full-UUID or unambiguous-prefix tokens in a
    // message body resolve to a known task, mirroring the portal's TASK_REF_RE/taskByRef.
    @Test
    fun resolvesFullUuidTaskRef() {
        val target = TaskDto(id = "d87de515-710e-4588-96fc-5822c0801cc7", title = "Clickable links")
        val tasks = listOf(target, TaskDto(id = "6a8771a2-7335-40b3-99ff-53208ef1eb6b", title = "iOS twin"))

        val matches = OrchaSelectors.taskRefMatches("see task d87de515-710e-4588-96fc-5822c0801cc7 please", tasks)

        assertEquals(1, matches.size)
        assertEquals(target, matches.single().task)
    }

    @Test
    fun resolvesUniqueEightCharPrefix() {
        val target = TaskDto(id = "d87de515-710e-4588-96fc-5822c0801cc7", title = "Clickable links")
        val tasks = listOf(target, TaskDto(id = "6a8771a2-7335-40b3-99ff-53208ef1eb6b", title = "iOS twin"))

        val matches = OrchaSelectors.taskRefMatches("blocked on d87de515 for now", tasks)

        assertEquals(1, matches.size)
        assertEquals(target, matches.single().task)
    }

    @Test
    fun ambiguousPrefixDoesNotResolve() {
        val tasks = listOf(
            TaskDto(id = "d87de515-710e-4588-96fc-5822c0801cc7", title = "Clickable links"),
            TaskDto(id = "d87de515-aaaa-4588-96fc-5822c0801cc7", title = "Collides on prefix"),
        )

        val matches = OrchaSelectors.taskRefMatches("see d87de515 for details", tasks)

        assertEquals(0, matches.size)
    }

    @Test
    fun unknownIdPassesThroughUnresolved() {
        val tasks = listOf(TaskDto(id = "d87de515-710e-4588-96fc-5822c0801cc7", title = "Clickable links"))

        val matches = OrchaSelectors.taskRefMatches("cross-container task ffffffff-ffff-ffff-ffff-ffffffffffff", tasks)

        assertEquals(0, matches.size)
    }
}

