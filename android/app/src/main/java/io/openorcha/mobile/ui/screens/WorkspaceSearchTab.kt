package io.openorcha.mobile.ui.screens

/* Search tab (iOS `SearchTabView` parity): global search across tasks/agents/requests
   of the selected workspace, with per-device recent searches; result rows deep-link
   to the existing detail routes. */

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.domain.SearchView
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LPriorityGlyph
import io.openorcha.mobile.ui.components.LSearchField
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

private const val RECENTS_PREFS = "orcha_search"
private const val RECENTS_KEY = "search.recents"
private const val RECENTS_MAX = 6

/** Pushes [query] to the front of [recents] (trimmed, case-insensitively deduped, max 6). */
internal fun pushRecentSearch(recents: List<String>, query: String): List<String> {
    val q = query.trim()
    if (q.isEmpty()) return recents
    return (listOf(q) + recents.filterNot { it.equals(q, ignoreCase = true) }).take(RECENTS_MAX)
}

private fun loadRecents(ctx: Context): List<String> =
    ctx.getSharedPreferences(RECENTS_PREFS, Context.MODE_PRIVATE)
        .getString(RECENTS_KEY, "").orEmpty()
        .split('\n').filter { it.isNotBlank() }

private fun saveRecents(ctx: Context, recents: List<String>) {
    ctx.getSharedPreferences(RECENTS_PREFS, Context.MODE_PRIVATE)
        .edit().putString(RECENTS_KEY, recents.joinToString("\n")).apply()
}

@Composable
internal fun SearchTab(
    snapshot: ContainerSnapshot?,
    humanId: String?,
    query: String,
    onQueryChange: (String) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
) {
    val ctx = LocalContext.current
    var recents by remember { mutableStateOf(loadRecents(ctx)) }
    val rememberQuery = {
        val next = pushRecentSearch(recents, query)
        if (next != recents) { recents = next; saveRecents(ctx, next) }
    }
    val trimmed = query.trim()
    // Opening the tab puts the caret in the field so typing works immediately (iOS @FocusState parity).
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        runCatching { focusRequester.requestFocus() }
        keyboard?.show()
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
        verticalArrangement = Arrangement.spacedBy(LSpace.xl),
    ) {
        item(key = "search-field") {
            LSearchField(
                query, onQueryChange,
                placeholder = "Search tasks, agents, requests",
                // LSearchField's modifier sits on its Row; the requester focuses the first focus target inside (the text field).
                modifier = Modifier.focusRequester(focusRequester),
            )
        }
        if (trimmed.isEmpty()) {
            if (recents.isEmpty()) {
                item(key = "search-idle") {
                    LEmptyState(
                        icon = OrchaIcons.Search,
                        title = "Search this workspace",
                        message = "Tasks, agents, and requests — matches open the same detail screens as the tabs.",
                        modifier = Modifier.padding(top = 40.dp),
                    )
                }
            } else {
                item(key = "search-recents") {
                    LSection(
                        "Recent",
                        count = recents.size,
                        trailing = {
                            TextButton(onClick = { recents = emptyList(); saveRecents(ctx, emptyList()) }) {
                                Text("Clear", style = ltype(LType.Meta), color = Orcha.palette.muted)
                            }
                        },
                    ) {
                        Column {
                            recents.forEach { recent ->
                                LinearListRow(
                                    title = recent,
                                    onClick = { onQueryChange(recent) },
                                    leading = { Icon(OrchaIcons.Schedule, null, tint = Orcha.palette.muted, modifier = Modifier.size(16.dp)) },
                                    trailing = { Icon(OrchaIcons.ArrowForward, null, tint = Orcha.palette.faint, modifier = Modifier.size(14.dp)) },
                                )
                            }
                        }
                    }
                }
            }
        } else {
            val tasks = SearchView.matchTasks(snapshot?.tasks.orEmpty(), trimmed)
            val agents = SearchView.matchAgents(snapshot?.agents.orEmpty(), trimmed)
            val requests = SearchView.matchRequests(snapshot?.requests.orEmpty(), trimmed)

            if (tasks.isEmpty() && agents.isEmpty() && requests.isEmpty()) {
                item(key = "search-none") {
                    LEmptyState(
                        icon = OrchaIcons.Search,
                        title = "No matches",
                        message = "Nothing matches “$trimmed”. Try a title, an agent, or a status.",
                        modifier = Modifier.padding(top = 24.dp),
                    )
                }
            }
            if (tasks.isNotEmpty()) {
                item(key = "search-tasks") {
                    LSection("Tasks", count = tasks.size) {
                        Column { tasks.forEach { t -> SearchTaskRow(t) { rememberQuery(); onOpenTask(t.id) } } }
                    }
                }
            }
            if (agents.isNotEmpty()) {
                item(key = "search-agents") {
                    LSection("Agents", count = agents.size) {
                        Column { agents.forEach { a -> SearchAgentRow(a) { rememberQuery(); onOpenAgent(a.id) } } }
                    }
                }
            }
            if (requests.isNotEmpty()) {
                item(key = "search-requests") {
                    LSection("Requests", count = requests.size) {
                        Column {
                            requests.forEach { r ->
                                SearchRequestRow(r, snapshot?.agents.orEmpty(), humanId) { rememberQuery(); onOpenRequest(r.id) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchTaskRow(task: TaskDto, onClick: () -> Unit) {
    LinearListRow(
        title = task.title,
        subtitle = MobileUx.statusCopy(task.status),
        onClick = onClick,
        leading = {
            androidx.compose.foundation.layout.Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
            ) {
                LPriorityGlyph(task.priority)
                LStatusGlyph(task.status)
            }
        },
        trailingText = task.shortId,
        trailingMono = true,
    )
}

@Composable
private fun SearchAgentRow(agent: AgentDto, onClick: () -> Unit) {
    LinearListRow(
        title = agent.alias,
        subtitle = agent.role?.takeIf { it.isNotBlank() },
        onClick = onClick,
        leading = { LAvatar(agent.alias, isAI = agent.kind != "human", size = 24.dp, status = agent.status) },
        trailingText = MobileUx.statusCopy(agent.status ?: "idle"),
    )
}

@Composable
private fun SearchRequestRow(req: RequestDto, agents: List<AgentDto>, humanId: String?, onClick: () -> Unit) {
    val from = RequestsView.aliasFor(agents, req.requesterId) ?: req.requesterAlias ?: "agent"
    LinearListRow(
        title = req.payload,
        subtitle = RequestsView.directionLabel(req, agents, humanId),
        onClick = onClick,
        leading = { LAvatar(from, isAI = RequestsView.kindFor(agents, req.requesterId) != "human", size = 20.dp) },
        trailingText = MobileUx.agoLabel(req.createdAt),
    )
}
