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

// GH #140: the wire format for a "task link" inside a request/conversation/thread message
// body is a bare task-id token — a full UUID or an unambiguous hex prefix (>=8 chars) — not
// markdown, a custom scheme, or a URL. This mirrors the portal's TASK_REF_RE/taskByRef
// (orcha-cli/orcha_cli/templates/portal/static/app.js), the reference client for this contract.
data class TaskRefMatch(val range: IntRange, val task: TaskDto)

private val TASK_REF_RE =
    Regex("\\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\\b", RegexOption.IGNORE_CASE)

object OrchaSelectors {
    fun taskRefMatches(body: String, tasks: List<TaskDto>): List<TaskRefMatch> {
        if (tasks.isEmpty() || body.isEmpty()) return emptyList()
        val byId = tasks.associateBy { it.id.lowercase() }
        return TASK_REF_RE.findAll(body).mapNotNull { m ->
            val tok = m.value.lowercase()
            val task = byId[tok] ?: run {
                if (tok.length in 8 until 36) {
                    val hits = tasks.filter { it.id.lowercase().startsWith(tok) }
                    hits.singleOrNull()
                } else null
            }
            task?.let { TaskRefMatch(m.range, it) }
        }.toList()
    }
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

