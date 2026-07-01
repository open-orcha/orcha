package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import kotlin.test.Test
import kotlin.test.assertEquals

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
}

