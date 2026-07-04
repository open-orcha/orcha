package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto

data class NeedsYou(
    val planApprovals: List<TaskDto>,
    val verifications: List<TaskDto>,
    val requests: List<RequestDto>,
) {
    val total: Int = planApprovals.size + verifications.size + requests.size
}

object OrchaSelectors {
    fun humanAgent(snapshot: ContainerSnapshot?): AgentDto? =
        snapshot?.agents?.firstOrNull { it.kind == "human" }

    fun needsYou(snapshot: ContainerSnapshot?): NeedsYou {
        if (snapshot == null) return NeedsYou(emptyList(), emptyList(), emptyList())
        val humanId = humanAgent(snapshot)?.id
        val plans = snapshot.tasks.filter {
            it.status == "in_progress" && it.planMessage != null && it.planDecision == null
        }
        val verifications = snapshot.tasks.filter { it.status == "needs_verification" }
        val requests = snapshot.requests.filter {
            it.status == "open" && (humanId == null || it.targetId == humanId)
        }
        return NeedsYou(plans, verifications, requests)
    }

    fun tasksByStatus(tasks: List<TaskDto>): Map<String, List<TaskDto>> =
        tasks.groupBy { it.status }.toSortedMap(statusComparator)

    fun statusCount(tasks: List<TaskDto>, status: String): Int =
        tasks.count { it.status == status }

    private val statusComparator = compareBy<String> {
        when (it) {
            "in_progress" -> 0
            "needs_verification" -> 1
            "ready" -> 2
            "blocked" -> 3
            "completed" -> 4
            "cancelled" -> 5
            else -> 9
        }
    }.thenBy { it }
}

