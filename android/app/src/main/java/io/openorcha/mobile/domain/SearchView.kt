package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto

/**
 * Global workspace search (iOS `SearchTabView` parity): case-insensitive `contains`
 * over the fields a human would scan for, across tasks/agents/requests of the
 * selected workspace. Pure — unit-tested here; screens render the results verbatim.
 */
object SearchView {

    /** iOS `matchTasks`: title, description, status, owner alias, or any assignee. */
    fun matchTasks(tasks: List<TaskDto>, query: String): List<TaskDto> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return tasks.filter { task ->
            hit(needle, task.title, task.description, task.status, task.ownerAlias) ||
                task.assignees.any { it.lowercase().contains(needle) }
        }
    }

    /** iOS `matchAgents`: alias, role, or status. */
    fun matchAgents(agents: List<AgentDto>, query: String): List<AgentDto> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return agents.filter { hit(needle, it.alias, it.role, it.status) }
    }

    /** iOS `matchRequests`: payload, requester/target alias, or status. */
    fun matchRequests(requests: List<RequestDto>, query: String): List<RequestDto> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        return requests.filter { hit(needle, it.payload, it.requesterAlias, it.targetAlias, it.status) }
    }

    private fun hit(needle: String, vararg haystack: String?): Boolean =
        haystack.any { (it ?: "").lowercase().contains(needle) }
}
