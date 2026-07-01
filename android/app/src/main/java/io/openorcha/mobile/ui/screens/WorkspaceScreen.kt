package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onForget: () -> Unit,
    onTab: (WorkspaceTab) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val selected = state.selectedContainer
    val snapshot = state.snapshot

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(selected?.displayName ?: "Orcha", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            selected?.baseUrl.orEmpty(),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Rounded.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Forget this Orcha") }, onClick = {
                            menuOpen = false
                            onForget()
                        })
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = state.selectedTab == WorkspaceTab.Home,
                    onClick = { onTab(WorkspaceTab.Home) },
                    icon = { Icon(Icons.Rounded.Home, contentDescription = null) },
                    label = { Text("Home") },
                )
                NavigationBarItem(
                    selected = state.selectedTab == WorkspaceTab.Tasks,
                    onClick = { onTab(WorkspaceTab.Tasks) },
                    icon = { Icon(Icons.AutoMirrored.Rounded.Assignment, contentDescription = null) },
                    label = { Text("Tasks") },
                )
                NavigationBarItem(
                    selected = state.selectedTab == WorkspaceTab.Requests,
                    onClick = { onTab(WorkspaceTab.Requests) },
                    icon = { Icon(Icons.Rounded.Inbox, contentDescription = null) },
                    label = { Text("Requests") },
                )
                NavigationBarItem(
                    selected = state.selectedTab == WorkspaceTab.Agents,
                    onClick = { onTab(WorkspaceTab.Agents) },
                    icon = { Icon(Icons.Rounded.AccountCircle, contentDescription = null) },
                    label = { Text("Agents") },
                )
            }
        },
    ) { padding ->
        if (snapshot == null && state.loading) {
            LoadingState(Modifier.padding(padding))
        } else if (snapshot == null) {
            UnreachableState(Modifier.padding(padding), state.error, onRefresh)
        } else {
            when (state.selectedTab) {
                WorkspaceTab.Home -> HomeTab(state, onOpenTask, Modifier.padding(padding))
                WorkspaceTab.Tasks -> TasksTab(snapshot.tasks, onOpenTask, Modifier.padding(padding))
                WorkspaceTab.Requests -> RequestsTab(snapshot.requests, Modifier.padding(padding))
                WorkspaceTab.Agents -> AgentsTab(snapshot.agents, Modifier.padding(padding))
            }
        }
    }
}

@Composable
private fun HomeTab(state: OrchaUiState, onOpenTask: (String) -> Unit, modifier: Modifier = Modifier) {
    val snapshot = state.snapshot ?: return
    val needsYou = OrchaSelectors.needsYou(snapshot)
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionTitle("Needs you", "${needsYou.total} item(s)")
        }
        if (needsYou.total == 0) {
            item { QuietCard("Nothing needs you right now.") }
        }
        items(needsYou.planApprovals, key = { "plan-${it.id}" }) {
            TaskRow("Plan approval", it, onOpenTask)
        }
        items(needsYou.verifications, key = { "verify-${it.id}" }) {
            TaskRow("Verify task", it, onOpenTask)
        }
        items(needsYou.requests, key = { it.id }) {
            RequestRow(it)
        }
        item {
            SectionTitle("Today", "${snapshot.tasks.size} tasks")
        }
        item {
            StatStrip(snapshot.tasks)
        }
        item {
            SectionTitle("Agents", "${snapshot.agents.size} total")
        }
        items(snapshot.agents.take(6), key = { it.id }) {
            AgentRow(it)
        }
    }
}

@Composable
private fun TasksTab(tasks: List<TaskDto>, onOpenTask: (String) -> Unit, modifier: Modifier = Modifier) {
    val grouped = OrchaSelectors.tasksByStatus(tasks)
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        grouped.forEach { (status, rows) ->
            item { SectionTitle(status.replace('_', ' '), "${rows.size}") }
            items(rows, key = { it.id }) { task -> TaskRow(null, task, onOpenTask) }
        }
    }
}

@Composable
private fun RequestsTab(requests: List<RequestDto>, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (requests.isEmpty()) item { QuietCard("No requests in this view.") }
        items(requests, key = { it.id }) { RequestRow(it) }
    }
}

@Composable
private fun AgentsTab(agents: List<AgentDto>, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(agents, key = { it.id }) { AgentRow(it) }
    }
}

@Composable
private fun StatStrip(tasks: List<TaskDto>) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        StatCard("Working", OrchaSelectors.statusCount(tasks, "in_progress"), Modifier.weight(1f))
        StatCard("Verify", OrchaSelectors.statusCount(tasks, "needs_verification"), Modifier.weight(1f))
        StatCard("Done", OrchaSelectors.statusCount(tasks, "completed"), Modifier.weight(1f))
    }
}

@Composable
private fun StatCard(label: String, count: Int, modifier: Modifier = Modifier) {
    Card(modifier = modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(12.dp)) {
            Text(count.toString(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun TaskRow(prefix: String?, task: TaskDto, onOpenTask: (String) -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenTask(task.id) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            prefix?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
            Text(task.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            task.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            StatusPill(task.status, StatusDomain.Task)
        }
    }
}

@Composable
private fun RequestRow(request: RequestDto) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("From ${request.requesterAlias ?: "unknown"}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(request.payload, maxLines = 3, overflow = TextOverflow.Ellipsis)
            StatusPill(request.status, StatusDomain.Request)
        }
    }
}

@Composable
private fun AgentRow(agent: AgentDto) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(agent.alias, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(agent.role ?: agent.kind, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
            }
            agent.currentTask?.title?.let {
                Text("Task: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, meta: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun QuietCard(text: String) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Text(text, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun LoadingState(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Loading Orcha", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("Fetching the latest tasks, requests, and agents.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun UnreachableState(modifier: Modifier = Modifier, error: String?, onRetry: () -> Unit) {
    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Orcha is unreachable", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(error ?: "Check that the computer is awake, Orcha is running, and both devices are on the same network.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        androidx.compose.material3.Button(onClick = onRetry) { Text("Try again") }
    }
}
