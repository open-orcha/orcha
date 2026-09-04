package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Global search (iOS `SearchTabView` parity): case-insensitive contains over the
 *  fields a human would scan for, across tasks/agents/requests. */
class SearchViewTest {

    private val tasks = listOf(
        TaskDto(id = "t1", title = "Fix the login bug", description = "OAuth redirect loop", status = "in_progress", ownerAlias = "kedar", assignees = listOf("Andrew")),
        TaskDto(id = "t2", title = "Write docs", description = null, status = "completed", ownerAlias = "Informer", assignees = emptyList()),
    )
    private val agents = listOf(
        AgentDto(id = "a1", alias = "Andrew", role = "backend engineer", kind = "ai", status = "working"),
        AgentDto(id = "a2", alias = "Informer", role = "docs", kind = "ai", status = "idle"),
    )
    private val requests = listOf(
        RequestDto(id = "r1", payload = "Need review on the login fix", status = "open", requesterAlias = "Andrew", targetAlias = "kedar"),
        RequestDto(id = "r2", payload = "Deploy window?", status = "answered", requesterAlias = "Informer", targetAlias = null),
    )

    @Test
    fun blankQueryMatchesNothing() {
        assertTrue(SearchView.matchTasks(tasks, "").isEmpty())
        assertTrue(SearchView.matchTasks(tasks, "   ").isEmpty())
        assertTrue(SearchView.matchAgents(agents, "").isEmpty())
        assertTrue(SearchView.matchRequests(requests, "").isEmpty())
    }

    @Test
    fun tasksMatchTitleDescriptionStatusOwnerOrAssignee() {
        assertEquals(listOf("t1"), SearchView.matchTasks(tasks, "login").map { it.id })
        assertEquals(listOf("t1"), SearchView.matchTasks(tasks, "oauth").map { it.id })
        assertEquals(listOf("t2"), SearchView.matchTasks(tasks, "completed").map { it.id })
        assertEquals(listOf("t2"), SearchView.matchTasks(tasks, "informer").map { it.id })
        assertEquals(listOf("t1"), SearchView.matchTasks(tasks, "andrew").map { it.id })
    }

    @Test
    fun tasksMatchIsCaseInsensitive() {
        assertEquals(listOf("t1"), SearchView.matchTasks(tasks, "LOGIN").map { it.id })
    }

    @Test
    fun agentsMatchAliasRoleOrStatus() {
        assertEquals(listOf("a1"), SearchView.matchAgents(agents, "backend").map { it.id })
        assertEquals(listOf("a2"), SearchView.matchAgents(agents, "docs").map { it.id })
        assertEquals(listOf("a1"), SearchView.matchAgents(agents, "working").map { it.id })
    }

    @Test
    fun requestsMatchPayloadOrAliases() {
        assertEquals(listOf("r1"), SearchView.matchRequests(requests, "review").map { it.id })
        assertEquals(listOf("r1"), SearchView.matchRequests(requests, "kedar").map { it.id })
        assertEquals(listOf("r2"), SearchView.matchRequests(requests, "deploy").map { it.id })
    }

    @Test
    fun noMatchesReturnsEmptyLists() {
        assertTrue(SearchView.matchTasks(tasks, "nonexistent-zzz").isEmpty())
        assertTrue(SearchView.matchAgents(agents, "nonexistent-zzz").isEmpty())
        assertTrue(SearchView.matchRequests(requests, "nonexistent-zzz").isEmpty())
    }
}
