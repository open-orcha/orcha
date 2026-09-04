package io.openorcha.mobile.ui.screens

/* Search tab (iOS `SearchTabView` parity): global search across tasks/agents/requests
   of the selected workspace; result rows deep-link to the existing detail routes. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.SearchView
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

@Composable
internal fun SearchTab(
    snapshot: ContainerSnapshot?,
    query: String,
    onQueryChange: (String) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
) {
    val p = Orcha.palette
    val trimmed = query.trim()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            OrchaField(
                query, onQueryChange,
                placeholder = "Search tasks, agents, requests",
                maxLines = 1,
            )
        }
        if (trimmed.isEmpty()) {
            item {
                StateLayout(
                    title = "Search this workspace",
                    sub = "Tasks, agents, and requests — matches open the same detail screens as the tabs.",
                    glyph = { Icon(OrchaIcons.Search, null, tint = p.muted) },
                )
            }
        } else {
            val tasks = SearchView.matchTasks(snapshot?.tasks.orEmpty(), trimmed)
            val agents = SearchView.matchAgents(snapshot?.agents.orEmpty(), trimmed)
            val requests = SearchView.matchRequests(snapshot?.requests.orEmpty(), trimmed)

            if (tasks.isEmpty() && agents.isEmpty() && requests.isEmpty()) {
                item { OrchaCard { Text("No matches for “$trimmed”.", color = p.muted) } }
            }
            if (tasks.isNotEmpty()) {
                item(key = "search-tasks-header") { SectionH("Tasks", "${tasks.size}") }
                items(tasks, key = { "search-task-${it.id}" }) { task -> SearchTaskRow(task, onOpenTask) }
            }
            if (agents.isNotEmpty()) {
                item(key = "search-agents-header") { SectionH("Agents", "${agents.size}") }
                items(agents, key = { "search-agent-${it.id}" }) { agent -> SearchAgentRow(agent, onOpenAgent) }
            }
            if (requests.isNotEmpty()) {
                item(key = "search-requests-header") { SectionH("Requests", "${requests.size}") }
                items(requests, key = { "search-request-${it.id}" }) { req -> SearchRequestRow(req, onOpenRequest) }
            }
        }
    }
}

@Composable
private fun SearchTaskRow(task: TaskDto, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = { onOpenTask(task.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(task.status, StatusDomain.Task)
            Spacer(Modifier.weight(1f))
            MetaTag("P${task.priority ?: 100}")
        }
        Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SearchAgentRow(agent: AgentDto, onOpenAgent: (String) -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = { onOpenAgent(agent.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Avatar(agent.alias, human = agent.kind == "human", size = AvatarSize.Sm)
            Column(Modifier.weight(1f)) {
                Text(agent.alias, style = MaterialTheme.typography.titleSmall)
                agent.role?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            StatusPill(agent.status ?: "idle", StatusDomain.Agent)
        }
    }
}

@Composable
private fun SearchRequestRow(req: RequestDto, onOpenRequest: (String) -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = { onOpenRequest(req.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            io.openorcha.mobile.ui.components.RequestStatusPill(req.status, escalated = false)
            Spacer(Modifier.weight(1f))
            Text(MobileUx.agoLabel(req.createdAt) ?: "", style = MonoSmStyle, color = p.faint)
        }
        Text(req.payload, style = MaterialTheme.typography.bodyMedium, color = p.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
