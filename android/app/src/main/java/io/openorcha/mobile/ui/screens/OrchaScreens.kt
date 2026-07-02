package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Assignment
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.OrchaColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContainersHomeScreen(
    state: OrchaUiState,
    onAdd: () -> Unit,
    onOpen: (String) -> Unit,
    onForget: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    Scaffold(
        topBar = {
            LargeTopAppBar(
                title = {
                    Column {
                        Text("Orcha")
                        Text("My Orchas", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAdd) { Icon(Icons.Rounded.Add, contentDescription = "Add Orcha") }
        },
    ) { padding ->
        if (state.containers.isEmpty()) {
            EmptyState(
                title = "Add your Orcha",
                body = "Open the portal on your computer and choose Pair phone. Until the pairing endpoint lands, enter the computer's Wi-Fi address.",
                action = "Add local Orcha",
                onAction = onAdd,
                modifier = Modifier.padding(padding),
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.containers, key = { it.id }) { container ->
                    ContainerCard(container, onOpen, onForget)
                }
            }
        }
    }
}

@Composable
private fun ContainerCard(container: StoredContainer, onOpen: (String) -> Unit, onForget: (String) -> Unit) {
    OrchaCard(Modifier.clickable { onOpen(container.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BrandMark()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(container.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(container.baseUrl, fontFamily = MonoFontFamily, style = MaterialTheme.typography.bodyMedium, color = OrchaColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusPill("saved", StatusDomain.Connection)
                    container.humanAlias?.let { MetaTag("as $it") }
                }
            }
            IconButton(onClick = { onForget(container.id) }) { Icon(Icons.Rounded.Delete, contentDescription = "Forget") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualConnectScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onConnect: (String) -> Unit,
) {
    var address by remember { mutableStateOf("") }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair Orcha") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                OrchaCard {
                    SectionHeader("QR pairing", "waiting on backend")
                    Text(
                        "The app is ready for the designed QR payload, but the running Orcha API does not expose a pairing-code endpoint yet. Paste a QR payload or enter the LAN address below.",
                        color = OrchaColors.Text2,
                    )
                }
            }
            item {
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 1,
                    maxLines = 5,
                    label = { Text("Address or QR payload") },
                    placeholder = { Text("192.168.1.8:8001") },
                )
            }
            item {
                Button(onClick = { onConnect(address) }, modifier = Modifier.fillMaxWidth(), enabled = !state.connecting) {
                    Text(if (state.connecting) "Connecting..." else "Connect")
                }
            }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onForget: () -> Unit,
    onTab: (WorkspaceTab) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    onCreateTask: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val snapshot = state.snapshot
    val selected = state.selectedContainer

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(selected?.displayName ?: "Orcha", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusPill(snapshot?.container?.status ?: "loading", StatusDomain.Connection)
                            Text(selected?.baseUrl.orEmpty(), fontFamily = MonoFontFamily, style = MaterialTheme.typography.labelSmall, color = OrchaColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") }
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, contentDescription = "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Switch container") }, onClick = { menuOpen = false; onBack() })
                        DropdownMenuItem(text = { Text("Disconnect") }, onClick = { menuOpen = false; onForget() })
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    NavItem(state.selectedTab == WorkspaceTab.Home, "Home", { Icon(Icons.Rounded.Home, null) }, Modifier.weight(1f)) { onTab(WorkspaceTab.Home) }
                    NavItem(state.selectedTab == WorkspaceTab.Tasks, "Tasks", { Icon(Icons.AutoMirrored.Rounded.Assignment, null) }, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                    NavItem(state.selectedTab == WorkspaceTab.Requests, "Requests", { Icon(Icons.Rounded.Inbox, null) }, Modifier.weight(1f)) { onTab(WorkspaceTab.Requests) }
                    NavItem(state.selectedTab == WorkspaceTab.Agents, "Agents", { Icon(Icons.Rounded.AccountCircle, null) }, Modifier.weight(1f)) { onTab(WorkspaceTab.Agents) }
                }
            }
        },
        floatingActionButton = {
            if (state.selectedTab == WorkspaceTab.Home || state.selectedTab == WorkspaceTab.Tasks) {
                FloatingActionButton(onClick = onCreateTask) { Icon(Icons.Rounded.Add, contentDescription = "Create task") }
            }
        },
    ) { padding ->
        when {
            snapshot == null && state.loading -> LoadingState("Loading Orcha", Modifier.padding(padding))
            snapshot == null -> EmptyState(
                "Orcha is unreachable",
                state.error ?: "Check that the computer is awake, Orcha is running, and both devices are on the same Wi-Fi.",
                "Try again",
                onRefresh,
                Modifier.padding(padding),
            )
            else -> when (state.selectedTab) {
                WorkspaceTab.Home -> HomeTab(state, onOpenTask, onOpenRequest, onOpenAgent, Modifier.padding(padding))
                WorkspaceTab.Tasks -> TasksTab(snapshot.tasks, onOpenTask, Modifier.padding(padding))
                WorkspaceTab.Requests -> RequestsTab(snapshot.requests, selected?.humanAgentId, onOpenRequest, Modifier.padding(padding))
                WorkspaceTab.Agents -> AgentsTab(snapshot.agents, onOpenAgent, Modifier.padding(padding))
            }
        }
    }
}

@Composable
private fun NavItem(selected: Boolean, label: String, icon: @Composable () -> Unit, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(
        modifier = modifier
            .padding(vertical = 6.dp, horizontal = 3.dp)
            .background(if (selected) OrchaColors.Accent.copy(alpha = 0.14f) else Color.Transparent, RoundedCornerShape(18.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 7.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        icon()
        Text(label, style = MaterialTheme.typography.labelSmall, color = if (selected) OrchaColors.Accent else OrchaColors.Muted)
    }
}

@Composable
private fun HomeTab(
    state: OrchaUiState,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val snapshot = state.snapshot ?: return
    val needsYou = OrchaSelectors.needsYou(snapshot)
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionHeader("Needs you", "${needsYou.total}") }
        if (needsYou.total == 0) item { QuietCard("Nothing needs you right now.") }
        items(needsYou.planApprovals, key = { "plan-${it.id}" }) { task -> TaskRow("Plan approval", task, onOpenTask) }
        items(needsYou.verifications, key = { "verify-${it.id}" }) { task -> TaskRow("Verify task", task, onOpenTask) }
        items(needsYou.requests, key = { it.id }) { request -> RequestRow(request, state.selectedContainer?.humanAgentId, onOpenRequest) }
        item { SectionHeader("Agents", "${snapshot.agents.size}") }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(snapshot.agents, key = { it.id }) { agent -> AgentChip(agent, onOpenAgent) }
            }
        }
        item { SectionHeader("Tasks", "${snapshot.tasks.size}") }
        item { StatStrip(snapshot.tasks) }
    }
}

@Composable
private fun TasksTab(tasks: List<TaskDto>, onOpenTask: (String) -> Unit, modifier: Modifier = Modifier) {
    val order = listOf("in_progress", "blocked", "needs_verification", "ready", "pending", "not_ready", "completed", "cancelled")
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        order.forEach { status ->
            val rows = tasks.filter { it.status == status }.sortedWith(compareBy<TaskDto> { it.priority ?: 100 }.thenByDescending { it.createdAt })
            if (rows.isNotEmpty()) {
                item { SectionHeader(status.replace('_', ' '), "${rows.size}") }
                items(rows, key = { it.id }) { task -> TaskRow(null, task, onOpenTask) }
            }
        }
        val known = order.toSet()
        val other = tasks.filterNot { it.status in known }
        if (other.isNotEmpty()) {
            item { SectionHeader("Other", "${other.size}") }
            items(other, key = { it.id }) { task -> TaskRow(null, task, onOpenTask) }
        }
        if (tasks.isEmpty()) item { QuietCard("No tasks yet. Create one with the plus button.") }
    }
}

@Composable
private fun RequestsTab(requests: List<RequestDto>, humanId: String?, onOpenRequest: (String) -> Unit, modifier: Modifier = Modifier) {
    val needs = requests.filter { it.status == "open" && (it.targetId == humanId || it.targetId == null) }
    val waiting = requests.filter { it.requesterId == humanId && it.status in setOf("open", "accepted") }
    val answered = requests.filter { it.requesterId == humanId && it.status == "answered" }
    val done = requests.filter { it.status in setOf("closed", "rejected", "converted_to_task") && (it.requesterId == humanId || it.targetId == humanId) }
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        RequestGroup("Needs your answer", needs, humanId, onOpenRequest)
        RequestGroup("Waiting on others", waiting, humanId, onOpenRequest)
        RequestGroup("Answered - act on it", answered, humanId, onOpenRequest)
        RequestGroup("Done", done, humanId, onOpenRequest)
        if (needs.isEmpty() && waiting.isEmpty() && answered.isEmpty() && done.isEmpty()) item { QuietCard("No requests involving you.") }
    }
}

private fun LazyListScope.RequestGroup(title: String, rows: List<RequestDto>, humanId: String?, onOpenRequest: (String) -> Unit) {
    if (rows.isEmpty()) return
    item { SectionHeader(title, "${rows.size}") }
    items(rows, key = { it.id }) { request -> RequestRow(request, humanId, onOpenRequest) }
}

@Composable
private fun AgentsTab(agents: List<AgentDto>, onOpenAgent: (String) -> Unit, modifier: Modifier = Modifier) {
    val sorted = agents.sortedWith(compareBy<AgentDto> {
        when (it.status) {
            "working" -> 0
            "awaiting_human", "blocked", "awaiting_request" -> 1
            "idle" -> 2
            "terminated" -> 4
            else -> 3
        }
    }.thenBy { it.kind }.thenBy { it.alias })
    LazyColumn(modifier = modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(sorted, key = { it.id }) { agent -> AgentRow(agent, onOpenAgent) }
        if (agents.isEmpty()) item { QuietCard("No agents yet. Create agents from the laptop portal.") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSendMessage: (String) -> Unit,
    onCancelTask: (String?) -> Unit,
    onVerify: (Boolean, String?) -> Unit,
    onDecidePlan: (Boolean, String?) -> Unit,
    onOpenRun: (RunDto) -> Unit,
) {
    val task = state.selectedTask
    var menuOpen by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var decisionText by remember { mutableStateOf("") }
    var closeReason by remember { mutableStateOf("") }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(task?.title ?: "Task", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") }
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, contentDescription = "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Close task") }, onClick = { menuOpen = false; onCancelTask(closeReason) })
                    }
                },
            )
        },
    ) { padding ->
        if (task == null) {
            EmptyState("Task not found", "Refresh the workspace and try again.", null, null, Modifier.padding(padding))
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                OrchaCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusPill(task.status, StatusDomain.Task)
                        MetaTag("P${task.priority ?: 100}")
                        if (task.isRoot) MetaTag("root")
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(task.title, style = MaterialTheme.typography.titleLarge)
                    task.description?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, color = OrchaColors.Text2)
                    }
                }
            }
            if (task.planMessage != null && task.planDecision == null) {
                item {
                    ActionCard("Plan approval", task.planMessage.body, OrchaColors.Violet) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { onDecidePlan(true, null) }, enabled = !state.actionInFlight) { Text("Approve") }
                            FilledTonalButton(onClick = { onDecidePlan(false, decisionText) }, enabled = decisionText.isNotBlank() && !state.actionInFlight) { Text("Request changes") }
                        }
                        OutlinedTextField(value = decisionText, onValueChange = { decisionText = it }, label = { Text("Feedback for changes") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                    }
                }
            }
            if (task.status == "needs_verification") {
                item {
                    ActionCard("Verify task", task.result ?: task.definitionOfDone.orEmpty(), OrchaColors.Ok) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { onVerify(true, null) }, enabled = !state.actionInFlight) { Text("Approve & complete") }
                            FilledTonalButton(onClick = { onVerify(false, decisionText) }, enabled = decisionText.isNotBlank() && !state.actionInFlight) { Text("Send back") }
                        }
                        OutlinedTextField(value = decisionText, onValueChange = { decisionText = it }, label = { Text("Feedback for send back") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                    }
                }
            }
            item { DetailSection("Definition of done", task.definitionOfDone ?: "No definition of done was provided.") }
            item {
                OrchaCard {
                    SectionHeader("Close task", "optional")
                    OutlinedTextField(value = closeReason, onValueChange = { closeReason = it }, label = { Text("Reason") }, modifier = Modifier.fillMaxWidth())
                    FilledTonalButton(onClick = { onCancelTask(closeReason) }, enabled = !task.isRoot && task.status !in setOf("completed", "cancelled") && !state.actionInFlight) {
                        Text("Close task")
                    }
                }
            }
            item { SectionHeader("Thread", "${state.taskMessages.size}") }
            items(state.taskMessages, key = { it.messageId ?: it.createdAt ?: it.body }) { msg -> MessageBubble(msg, state.selectedContainer?.humanAgentId) }
            item {
                OrchaCard {
                    OutlinedTextField(value = message, onValueChange = { message = it }, modifier = Modifier.fillMaxWidth(), minLines = 2, label = { Text("Message thread") })
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = { onSendMessage(message); message = "" }, enabled = message.isNotBlank() && !state.actionInFlight) {
                        Icon(Icons.Rounded.Send, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("Send")
                    }
                }
            }
            item { SectionHeader("Worker runs", "${state.taskRuns.size}") }
            if (state.taskRuns.isEmpty()) item { QuietCard("No runs yet - appears when a worker wakes for this task.") }
            items(state.taskRuns, key = { it.runId }) { run -> RunRow(run, onOpenRun) }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRespond: (String) -> Unit,
    onClose: (String?) -> Unit,
    onNudge: (String?) -> Unit,
    onEscalate: (String?) -> Unit,
    onAcceptTask: (String?) -> Unit,
    onRejectTask: (String) -> Unit,
    onConvert: (String, String, String?, Int) -> Unit,
) {
    val request = state.selectedRequest
    var text by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf("") }
    val humanId = state.selectedContainer?.humanAgentId
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Request") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        if (request == null) {
            EmptyState("Request not found", "Refresh the workspace and try again.", null, null, Modifier.padding(padding))
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                OrchaCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusPill(request.status, StatusDomain.Request)
                        MetaTag(request.type)
                        if (request.chainDepth > 0) MetaTag("chain")
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("${request.requesterAlias ?: "someone"} -> ${if (request.targetId == humanId) "you" else request.targetAlias ?: "human"}", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(request.payload, color = OrchaColors.Text2)
                    request.response?.let { DetailSection("Response", it) }
                    request.rejectionReason?.let { DetailSection("Rejection", it) }
                }
            }
            item {
                OrchaCard {
                    SectionHeader("Act", request.status)
                    OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("Reply, note, or reason") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (request.status == "open" && request.targetId == humanId && request.type == "info") Button(onClick = { onRespond(text) }, enabled = text.isNotBlank() && !state.actionInFlight) { Text("Respond") }
                        if (request.status == "open" && request.targetId == humanId && request.type == "task") Button(onClick = { onAcceptTask(text) }, enabled = !state.actionInFlight) { Text("Accept") }
                        if (request.status == "open" && request.targetId == humanId && request.type == "task") FilledTonalButton(onClick = { onRejectTask(text) }, enabled = text.isNotBlank() && !state.actionInFlight) { Text("Reject") }
                        if (request.status in setOf("open", "answered") && request.requesterId == humanId) OutlinedButton(onClick = { onNudge(text) }, enabled = !state.actionInFlight) { Text("Nudge") }
                        if (request.status in setOf("open", "answered")) FilledTonalButton(onClick = { onClose(text) }, enabled = request.requesterId == humanId || text.isNotBlank()) { Text("Close") }
                    }
                    if (request.status in setOf("open", "answered") && request.requesterId == humanId) {
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(onClick = { onEscalate(text) }, enabled = !state.actionInFlight) { Text("Escalate") }
                    }
                }
            }
            if (request.status == "answered" && request.requesterId == humanId && request.type == "info") {
                item {
                    OrchaCard {
                        SectionHeader("Convert to task", "optional")
                        OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Task title") }, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = dod, onValueChange = { dod = it }, label = { Text("Definition of done") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = assignee, onValueChange = { assignee = it }, label = { Text("Assignee alias") }, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = { onConvert(title, dod, assignee.ifBlank { null }, 100) }, enabled = title.isNotBlank() && dod.isNotBlank() && !state.actionInFlight) { Text("Create task") }
                    }
                }
            }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onConversation: (String) -> Unit,
    onModel: (String) -> Unit,
    onAutoWake: (Int?) -> Unit,
    onRetire: () -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRun: (RunDto) -> Unit,
) {
    val agent = state.selectedAgent
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(agent?.alias ?: "Agent") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = { IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") } },
            )
        },
    ) { padding ->
        if (agent == null) {
            EmptyState("Agent not found", "Refresh the workspace and try again.", null, null, Modifier.padding(padding))
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                OrchaCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(agent.alias, agent.kind == "human", large = true)
                        Column(Modifier.weight(1f)) {
                            Text(agent.alias, style = MaterialTheme.typography.titleLarge)
                            Text(agent.role ?: agent.kind, color = OrchaColors.Text2)
                        }
                        StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        agent.model?.let { MetaTag(it) }
                        MetaTag(if (agent.wakeEnabled == false) "wake off" else "wake on")
                        MetaTag(agent.autoWakeIntervalSecs?.let { "auto ${it / 60}m" } ?: "auto off")
                    }
                }
            }
            if (agent.kind == "ai" && agent.terminatedAt == null) {
                item {
                    Button(onClick = { onConversation(agent.id) }, modifier = Modifier.fillMaxWidth()) { Text("Converse") }
                }
            }
            agent.currentTask?.taskId?.let { taskId ->
                item {
                    OrchaCard(Modifier.clickable { onOpenTask(taskId) }) {
                        SectionHeader("Now", "task")
                        Text(agent.currentTask.title ?: taskId, style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
            item {
                OrchaCard {
                    SectionHeader("Controls", "human authority")
                    Text("Model changes apply on the agent's next wake.", color = OrchaColors.Muted)
                    Spacer(Modifier.height(8.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(state.models, key = { it.id }) { model ->
                            AssistChip(onClick = { onModel(model.id) }, label = { Text(model.name ?: model.id, maxLines = 1) })
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { onAutoWake(null) }) { Text("Auto off") }
                        OutlinedButton(onClick = { onAutoWake(300) }) { Text("5m") }
                        OutlinedButton(onClick = { onAutoWake(900) }) { Text("15m") }
                        OutlinedButton(onClick = { onAutoWake(3600) }) { Text("1h") }
                    }
                    Spacer(Modifier.height(10.dp))
                    FilledTonalButton(onClick = onRetire, enabled = agent.kind == "ai" && agent.terminatedAt == null) { Text("Retire agent") }
                }
            }
            item { DetailSection("Persona", agent.promptPreview ?: "No prompt preview available.") }
            item { SectionHeader("Recent runs", "${state.agentRuns.size}") }
            if (state.agentRuns.isEmpty()) item { QuietCard("No recent runs.") }
            items(state.agentRuns, key = { it.runId }) { run -> RunRow(run.copy(agentId = run.agentId ?: agent.id, agentAlias = run.agentAlias ?: agent.alias), onOpenRun) }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onStop: () -> Unit,
) {
    val run = state.selectedRun
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(run?.runId?.take(8) ?: "Run", fontFamily = MonoFontFamily) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = { IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") } },
            )
        },
    ) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (run != null) {
                item {
                    OrchaCard {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusPill(run.status, StatusDomain.Run)
                            run.wakeKind?.let { MetaTag(it) }
                        }
                        Text(run.taskTitle ?: run.taskId ?: "Worker run", color = OrchaColors.Text2)
                        if (run.status == "running") {
                            Spacer(Modifier.height(8.dp))
                            FilledTonalButton(onClick = onStop, enabled = !state.actionInFlight) { Text("Stop run") }
                        }
                    }
                }
            }
            item {
                OrchaCard {
                    SectionHeader("Log", "${state.runLines.size} lines")
                    if (state.runLines.isEmpty()) Text(if (state.loading) "Loading stream..." else "No log lines yet.", color = OrchaColors.Muted)
                    state.runLines.forEach { line -> LogLine(line) }
                }
            }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSend: (String) -> Unit,
    onEnd: () -> Unit,
    onOpenRun: (RunDto) -> Unit,
) {
    val agent = state.selectedAgent
    var draft by remember { mutableStateOf("") }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(agent?.alias ?: "Conversation") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, contentDescription = "Refresh") }
                    IconButton(onClick = onEnd) { Icon(Icons.Rounded.Close, contentDescription = "End") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(modifier = Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (state.turns.isEmpty()) item { QuietCard("No conversation yet. Send a message to wake ${agent?.alias ?: "the agent"}.") }
                items(state.turns, key = { it.id ?: it.seq }) { turn -> TurnBubble(turn, state.selectedContainer?.humanAgentId, onOpenRun, agent) }
                state.error?.let { item { ErrorBanner(it) } }
            }
            Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.weight(1f), placeholder = { Text("Message ${agent?.alias ?: "agent"}") })
                Button(onClick = { onSend(draft); draft = "" }, enabled = draft.isNotBlank() && !state.actionInFlight) { Icon(Icons.Rounded.Send, contentDescription = "Send") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateTaskScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onCreate: (String, String?, String, String?, Int, List<String>, Boolean) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf(100) }
    var notReady by remember { mutableStateOf(false) }
    val agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Create task") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                actions = {
                    TextButton(
                        onClick = { onCreate(title, description.ifBlank { null }, dod, assignee.ifBlank { null }, priority, emptyList(), notReady) },
                        enabled = title.isNotBlank() && dod.isNotBlank() && !state.actionInFlight,
                    ) { Text("Create") }
                },
            )
        },
    ) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { OutlinedTextField(title, { title = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Title") }, singleLine = true) }
            item { OutlinedTextField(description, { description = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Description") }, minLines = 3) }
            item { OutlinedTextField(dod, { dod = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Definition of done") }, minLines = 3) }
            item {
                OrchaCard {
                    SectionHeader("Assign to", assignee.ifBlank { "unassigned" })
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        item { AssistChip(onClick = { assignee = "" }, label = { Text("Unassigned") }) }
                        items(agents, key = { it.id }) { agent ->
                            AssistChip(onClick = { assignee = agent.alias }, label = { Text(agent.alias) })
                        }
                    }
                }
            }
            item {
                OrchaCard {
                    SectionHeader("Priority", "P$priority")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { priority = 300 }) { Text("Low") }
                        Button(onClick = { priority = 100 }) { Text("Normal") }
                        OutlinedButton(onClick = { priority = 20 }) { Text("High") }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(onClick = { notReady = !notReady }) { Text(if (notReady) "Parked" else "Park it") }
                }
            }
            state.error?.let { item { ErrorBanner(it) } }
        }
    }
}

@Composable
fun ToastHost(state: OrchaUiState, onShown: () -> Unit) {
    val host = remember { SnackbarHostState() }
    LaunchedEffect(state.toast) {
        val toast = state.toast
        if (toast != null) {
            host.showSnackbar(toast)
            onShown()
        }
    }
    SnackbarHost(hostState = host)
}

@Composable
private fun TaskRow(prefix: String?, task: TaskDto, onOpenTask: (String) -> Unit) {
    OrchaCard(Modifier.clickable { onOpenTask(task.id) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusPill(task.status, StatusDomain.Task)
            MetaTag("P${task.priority ?: 100}")
            if (prefix != null) MetaTag(prefix)
        }
        Spacer(Modifier.height(8.dp))
        Text(task.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        task.description?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = OrchaColors.Text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(8.dp))
        Text(task.assignees.firstOrNull() ?: task.ownerAlias ?: "unassigned", color = OrchaColors.Muted, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun RequestRow(request: RequestDto, humanId: String?, onOpenRequest: (String) -> Unit) {
    OrchaCard(Modifier.clickable { onOpenRequest(request.id) }) {
        Text("${request.requesterAlias ?: "someone"} -> ${if (request.targetId == humanId) "you" else request.targetAlias ?: "human"}", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(6.dp))
        Text(request.payload, color = OrchaColors.Text2, maxLines = 3, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusPill(request.status, StatusDomain.Request)
            MetaTag(request.type)
        }
    }
}

@Composable
private fun AgentChip(agent: AgentDto, onOpenAgent: (String) -> Unit) {
    OrchaCard(Modifier.width(174.dp).clickable { onOpenAgent(agent.id) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(agent.alias, agent.kind == "human")
            Column {
                Text(agent.alias, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
            }
        }
    }
}

@Composable
private fun AgentRow(agent: AgentDto, onOpenAgent: (String) -> Unit) {
    OrchaCard(Modifier.clickable { onOpenAgent(agent.id) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(agent.alias, agent.kind == "human")
            Column(Modifier.weight(1f)) {
                Text(agent.alias, style = MaterialTheme.typography.titleMedium)
                Text(agent.role ?: agent.kind, color = OrchaColors.Text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                agent.currentTask?.title?.let { Text(it, color = OrchaColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
        }
    }
}

@Composable
private fun RunRow(run: RunDto, onOpenRun: (RunDto) -> Unit) {
    OrchaCard(Modifier.clickable { onOpenRun(run) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Terminal, contentDescription = null, tint = OrchaColors.Accent)
            Text(run.runId.take(8), fontFamily = MonoFontFamily, style = MaterialTheme.typography.titleSmall)
            StatusPill(run.status, StatusDomain.Run)
        }
        Text(run.taskTitle ?: run.wakeEvent ?: "worker run", color = OrchaColors.Text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun MessageBubble(message: TaskMessageDto, humanId: String?) {
    val mine = message.authorId != null && message.authorId == humanId
    val bg = if (mine) OrchaColors.Accent.copy(alpha = 0.20f) else OrchaColors.Surface3
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.fillMaxWidth(0.88f).background(bg, RoundedCornerShape(16.dp)).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(message.authorAlias ?: if (message.isHuman) "human" else "agent", style = MaterialTheme.typography.labelSmall, color = if (mine) OrchaColors.Accent else OrchaColors.Muted)
            Text(message.body, color = OrchaColors.Text)
            message.createdAt?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = OrchaColors.Faint) }
        }
    }
}

@Composable
private fun TurnBubble(turn: TurnDto, humanId: String?, onOpenRun: (RunDto) -> Unit, agent: AgentDto?) {
    val mine = turn.authorAgentId == humanId || turn.role == "human"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(Modifier.fillMaxWidth(0.88f).background(if (mine) OrchaColors.Accent.copy(alpha = 0.20f) else OrchaColors.Surface3, RoundedCornerShape(16.dp)).padding(12.dp)) {
            Text(if (mine) "you" else agent?.alias ?: "agent", style = MaterialTheme.typography.labelSmall, color = OrchaColors.Muted)
            Text(turn.content, color = OrchaColors.Text)
            turn.runId?.let {
                TextButton(onClick = { onOpenRun(RunDto(runId = it, agentId = agent?.id, agentAlias = agent?.alias, status = "exited")) }) {
                    Text("Open work log")
                }
            }
        }
    }
}

@Composable
private fun ActionCard(title: String, body: String, color: Color, controls: @Composable ColumnScope.() -> Unit) {
    OrchaCard(borderColor = color.copy(alpha = 0.35f)) {
        SectionHeader(title, "needs you")
        Text(body, color = OrchaColors.Text2, maxLines = 8, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(10.dp))
        controls()
    }
}

@Composable
private fun DetailSection(title: String, body: String) {
    OrchaCard {
        SectionHeader(title, "")
        Text(body, color = OrchaColors.Text2)
    }
}

@Composable
private fun StatStrip(tasks: List<TaskDto>) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        StatTile("Working", tasks.count { it.status == "in_progress" }, Modifier.weight(1f))
        StatTile("Verify", tasks.count { it.status == "needs_verification" }, Modifier.weight(1f))
        StatTile("Blocked", tasks.count { it.status == "blocked" }, Modifier.weight(1f))
    }
}

@Composable
private fun StatTile(label: String, count: Int, modifier: Modifier = Modifier) {
    OrchaCard(modifier) {
        Text("$count", style = MaterialTheme.typography.displaySmall, color = OrchaColors.Accent)
        Text(label, style = MaterialTheme.typography.labelSmall, color = OrchaColors.Muted)
    }
}

@Composable
private fun OrchaCard(modifier: Modifier = Modifier, borderColor: Color = OrchaColors.Border, content: @Composable ColumnScope.() -> Unit) {
    OutlinedCard(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.outlinedCardColors(containerColor = OrchaColors.Surface2),
        border = BorderStroke(1.dp, borderColor),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
    }
}

@Composable
private fun QuietCard(text: String) {
    OrchaCard { Text(text, color = OrchaColors.Muted) }
}

@Composable
private fun SectionHeader(title: String, meta: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = OrchaColors.Faint)
        if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.labelSmall, color = OrchaColors.Muted)
    }
}

@Composable
private fun MetaTag(text: String) {
    Text(
        text,
        modifier = Modifier.background(OrchaColors.Surface3, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
        style = MaterialTheme.typography.labelSmall,
        color = OrchaColors.Text2,
        fontFamily = if (text.length > 12) MonoFontFamily else null,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun Avatar(alias: String, human: Boolean, large: Boolean = false) {
    val size = if (large) 54.dp else 36.dp
    Box(
        modifier = Modifier.size(size).background(if (human) OrchaColors.Violet.copy(alpha = 0.22f) else OrchaColors.Accent.copy(alpha = 0.18f), if (human) CircleShape else RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text(alias.take(1).uppercase(), color = if (human) OrchaColors.Violet else OrchaColors.Accent, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun BrandMark() {
    Box(Modifier.size(40.dp).background(OrchaColors.Accent.copy(alpha = 0.14f), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Text("O", color = OrchaColors.Accent, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
private fun EmptyState(title: String, body: String, action: String?, onAction: (() -> Unit)?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.Start) {
        BrandMark()
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.displaySmall)
        Spacer(Modifier.height(8.dp))
        Text(body, color = OrchaColors.Text2)
        if (action != null && onAction != null) {
            Spacer(Modifier.height(18.dp))
            Button(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
private fun LoadingState(title: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center) {
        Text(title, style = MaterialTheme.typography.displaySmall)
        Spacer(Modifier.height(8.dp))
        Text("Fetching the latest tasks, requests, agents, and runs.", color = OrchaColors.Text2)
    }
}

@Composable
private fun ErrorBanner(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().background(OrchaColors.Danger.copy(alpha = 0.12f), RoundedCornerShape(12.dp)).padding(12.dp),
        color = OrchaColors.Danger,
    )
}

@Composable
private fun LogLine(line: String) {
    val color = when {
        "error" in line.lowercase() || "failed" in line.lowercase() -> OrchaColors.Danger
        "warn" in line.lowercase() -> OrchaColors.Warn
        "tool" in line.lowercase() -> OrchaColors.Accent
        else -> OrchaColors.Text2
    }
    Text(line, fontFamily = MonoFontFamily, style = MaterialTheme.typography.bodyMedium, color = color)
}
