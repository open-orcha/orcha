package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.theme.Orcha

/* Tasks tab (flow 05 T1): agent-alias chips + search, grouped-by-status list with
   the web-parity "Load more" render cap. */

/** Web page size (issue 4): tasks.html renders 10/page + "Load more". */
private const val TASKS_PAGE = 10

@Composable
internal fun TasksTab(tasks: List<TaskDto>, agents: List<AgentDto>, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    var filter by rememberSaveable { mutableStateOf("All") }
    var query by rememberSaveable { mutableStateOf("") }
    var expandedTerminals by rememberSaveable { mutableStateOf(false) }
    // issue 4: web-parity render cap (tasks.html: 10/page + "Load more"); resets on filter change
    var shown by rememberSaveable { mutableStateOf(TASKS_PAGE) }
    val aiAgents = agents.filter { it.kind == "ai" }
    LaunchedEffect(filter, query) { shown = TASKS_PAGE }

    val scoped = when (filter) {
        "All" -> tasks
        "Needs me" -> MobileUx.needsMe(tasks)
        else -> tasks.filter { it.assignees.contains(filter) || it.ownerAlias == filter }
    }
    // search composes with the active filter (flow 05: "search within filtered set")
    val filtered = if (query.isBlank()) scoped else scoped.filter {
        it.title.contains(query, ignoreCase = true) || (it.description ?: "").contains(query, ignoreCase = true)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            OrchaField(
                query, { query = it },
                placeholder = "Search tasks…",
                maxLines = 1,
            )
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val chips = listOf("All", "Needs me") + aiAgents.map { it.alias }
                items(chips, key = { it }) { chip ->
                    val on = chip == filter
                    val label = if (chip == "Needs me") "Needs me · ${MobileUx.needsMe(tasks).size}" else chip
                    Text(
                        label,
                        modifier = Modifier
                            .background(if (on) p.accentSoft else p.surface2, RoundedCornerShape(999.dp))
                            .border(BorderStroke(1.dp, if (on) p.accentLine else p.border), RoundedCornerShape(999.dp))
                            .clickable { filter = chip }
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W600),
                        color = if (on) p.accent else p.muted,
                    )
                }
            }
        }
        val groups = filtered.groupBy { it.status }.toList().sortedBy { MobileUx.taskGroupRank(it.first) }
        // issue 4: the render cap spans the whole tab (web tasks.html renders one capped
        // list); group headers keep their true counts so nothing hides silently.
        val visibleTotal = groups.sumOf { (status, rows) ->
            if (!MobileUx.isTerminalGroup(status) || expandedTerminals) rows.size else 0
        }
        var remaining = shown
        groups.forEach { (status, rows) ->
            val terminal = MobileUx.isTerminalGroup(status)
            item(key = "h-$status") {
                SectionH(MobileUx.statusCopy(status), "${rows.size}", trailing = {
                    if (terminal) Text(
                        if (expandedTerminals) "hide" else "show",
                        style = MaterialTheme.typography.labelMedium, color = p.accent,
                        modifier = Modifier.clickable { expandedTerminals = !expandedTerminals },
                    )
                })
            }
            if (!terminal || expandedTerminals) {
                val page = rows
                    .sortedWith(compareBy<TaskDto> { it.priority ?: 100 }.thenByDescending { it.createdAt ?: "" })
                    .take(remaining.coerceAtLeast(0))
                remaining -= page.size
                items(page, key = { it.id }) { task -> TaskRow(task, onOpenTask) }
            }
        }
        if (visibleTotal > shown) {
            item(key = "tasks-load-more") {
                LoadMoreRow(shown, visibleTotal) { shown += TASKS_PAGE }
            }
        }
        if (filtered.isEmpty()) item { OrchaCard { Text("No tasks here yet. Create one with the plus button.", color = p.muted) } }
        item { Spacer(Modifier.height(72.dp)) }
    }
}

@Composable
fun TaskRow(task: TaskDto, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = { onOpenTask(task.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(task.status, StatusDomain.Task)
            if (task.isRoot) MetaTag("root")
            Spacer(Modifier.weight(1f))
            val band = MobileUx.priorityBand(task.priority)
            MetaTag(
                "P${task.priority ?: 100}",
                tint = when (band) {
                    io.openorcha.mobile.domain.PriorityBand.High -> p.danger
                    io.openorcha.mobile.domain.PriorityBand.Elevated -> p.warn
                    else -> null
                },
            )
        }
        Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val assignee = task.assignees.firstOrNull() ?: task.ownerAlias
            if (assignee != null) {
                Avatar(assignee, human = false, size = AvatarSize.Sm)
                Text(assignee, style = MaterialTheme.typography.bodyMedium, color = p.text2)
            } else {
                Text("unassigned", style = MaterialTheme.typography.bodyMedium, color = p.faint)
            }
            Spacer(Modifier.weight(1f))
            Text(
                MobileUx.agoLabel(task.startedAt ?: task.createdAt)?.let { "updated $it" } ?: "",
                style = MaterialTheme.typography.bodyMedium, color = p.faint,
            )
        }
    }
}
