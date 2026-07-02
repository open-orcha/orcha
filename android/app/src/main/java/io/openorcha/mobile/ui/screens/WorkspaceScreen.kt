package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Checklist
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.SmartToy
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OkTonalButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.StatTile
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.ConnChip
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 04 — container workspace: bottom nav (badges), Home tab (needs-you queue,
   agents glance, stat tiles, activity), connection states.
   Flow 08 — approval sheets (plan approval + verify), shared with Task detail.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onForget: () -> Unit,
    onSettings: () -> Unit,
    onTab: (WorkspaceTab) -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    onCreateTask: () -> Unit,
    onDecidePlanFor: (String, Boolean, String?) -> Unit,
    onVerifyFor: (String, Boolean, String?) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val snapshot = state.snapshot
    val selected = state.selectedContainer
    val humanId = selected?.humanAgentId
    val needsYou = OrchaSelectors.needsYou(snapshot)
    val requestGroups = MobileUx.requestGroups(snapshot?.requests.orEmpty(), humanId)
    val paused = snapshot != null && snapshot.container.status != "active"

    var planSheetTask by remember { mutableStateOf<TaskDto?>(null) }
    var verifySheetTask by remember { mutableStateOf<TaskDto?>(null) }

    Scaffold(
        containerColor = Orcha.palette.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(selected?.displayName ?: "Orcha", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        ConnChip(if (snapshot == null) (if (state.loading) "probing" else "unreachable") else if (paused) "paused" else "polling")
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Settings") }, onClick = { menuOpen = false; onSettings() })
                        DropdownMenuItem(text = { Text("Switch container") }, onClick = { menuOpen = false; onBack() })
                        DropdownMenuItem(text = { Text("Disconnect", color = Orcha.palette.danger) }, onClick = { menuOpen = false; onForget() })
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar(containerColor = Orcha.palette.surface) {
                WorkspaceNavItem(state, WorkspaceTab.Home, "Home", Icons.Rounded.Home, badge = needsYou.total, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Tasks, "Tasks", Icons.Rounded.Checklist, badge = 0, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Requests, "Requests", Icons.Rounded.Forum, badge = requestGroups.badgeCount, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Agents, "Agents", Icons.Rounded.SmartToy, badge = 0, onTab)
            }
        },
        floatingActionButton = {
            if (state.selectedTab == WorkspaceTab.Home || state.selectedTab == WorkspaceTab.Tasks) {
                FloatingActionButton(
                    onClick = onCreateTask,
                    containerColor = Orcha.palette.accent,
                    contentColor = Orcha.palette.accentInk,
                ) { Icon(Icons.Rounded.Add, "Create task") }
            }
        },
    ) { padding ->
        when {
            snapshot == null && state.loading -> WorkspaceSkeleton(Modifier.padding(padding))
            snapshot == null -> StateLayout(
                title = "Can't reach your laptop",
                sub = "${selected?.baseUrl ?: "The container"} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(Icons.Rounded.WifiOff, null, tint = Orcha.palette.danger) },
            ) {
                OrchaCard {
                    Text("1  Is the phone on the same Wi-Fi as the laptop?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("2  Is the laptop awake and Orcha running?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("3  Firewall or VPN blocking the port?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                }
                NeutralButton("Try again", onRefresh)
            }
            else -> Column(Modifier.padding(padding)) {
                // connection-model banners (flow 04 H8/H10): polling is the honest v1
                // state (SSE is a listed follow-up); paused blocks agent action.
                if (paused) {
                    Banner(
                        BannerKind.Info,
                        "This Orcha is paused — agents won't act until resumed from the laptop.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                } else {
                    Banner(
                        BannerKind.Warn,
                        "Live updates unavailable — checking every 30s",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        action = "Refresh now",
                        onAction = onRefresh,
                    )
                }
                when (state.selectedTab) {
                    WorkspaceTab.Home -> HomeTab(
                        state, needsYou.planApprovals, needsYou.verifications, needsYou.requests,
                        onOpenTask, onOpenRequest, onOpenAgent, onTab,
                        onPlanSheet = { planSheetTask = it }, onVerifySheet = { verifySheetTask = it },
                    )
                    WorkspaceTab.Tasks -> TasksTab(snapshot.tasks, snapshot.agents, onOpenTask)
                    WorkspaceTab.Requests -> RequestsTab(requestGroups, snapshot.agents, humanId, onOpenRequest)
                    WorkspaceTab.Agents -> AgentsTab(snapshot.agents, onOpenAgent)
                }
            }
        }
    }

    planSheetTask?.let { task ->
        PlanApprovalSheet(
            task = task,
            busy = state.actionInFlight,
            onDismiss = { planSheetTask = null },
            onDecide = { approve, reason -> planSheetTask = null; onDecidePlanFor(task.id, approve, reason) },
        )
    }
    verifySheetTask?.let { task ->
        VerifySheet(
            task = task,
            busy = state.actionInFlight,
            onDismiss = { verifySheetTask = null },
            onVerify = { approve, feedback -> verifySheetTask = null; onVerifyFor(task.id, approve, feedback) },
        )
    }
}

@Composable
private fun RowScope.WorkspaceNavItem(
    state: OrchaUiState,
    tab: WorkspaceTab,
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    badge: Int,
    onTab: (WorkspaceTab) -> Unit,
) {
    NavigationBarItem(
        selected = state.selectedTab == tab,
        onClick = { onTab(tab) },
        icon = {
            BadgedBox(badge = { if (badge > 0) Badge(containerColor = Orcha.palette.danger) { Text("$badge") } }) {
                Icon(icon, label)
            }
        },
        label = { Text(label, style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.5.sp)) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Orcha.palette.accent,
            selectedTextColor = Orcha.palette.text,
            indicatorColor = Orcha.palette.accentSoft,
            unselectedIconColor = Orcha.palette.text2,
            unselectedTextColor = Orcha.palette.text2,
        ),
    )
}

@Composable
private fun WorkspaceSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Skeleton(14.dp, Modifier.width(120.dp))
        Skeleton(96.dp)
        Skeleton(96.dp)
        Skeleton(14.dp, Modifier.width(90.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Skeleton(74.dp, Modifier.weight(1f)); Skeleton(74.dp, Modifier.weight(1f))
            Skeleton(74.dp, Modifier.weight(1f)); Skeleton(74.dp, Modifier.weight(1f))
        }
        Skeleton(96.dp)
    }
}

/* ---------- Home tab (flow 04 H5): needs-you queue → agents glance → stats → activity ---------- */

@Composable
private fun HomeTab(
    state: OrchaUiState,
    planApprovals: List<TaskDto>,
    verifications: List<TaskDto>,
    requestsForMe: List<RequestDto>,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    onTab: (WorkspaceTab) -> Unit,
    onPlanSheet: (TaskDto) -> Unit,
    onVerifySheet: (TaskDto) -> Unit,
) {
    val snapshot = state.snapshot ?: return
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { SectionH("Needs you", "${planApprovals.size + verifications.size + requestsForMe.size}") }
        if (planApprovals.isEmpty() && verifications.isEmpty() && requestsForMe.isEmpty()) {
            item { OrchaCard { Text("Nothing needs you right now.", color = p.muted) } }
        }
        items(planApprovals, key = { "plan-${it.id}" }) { task ->
            OrchaCard(onClick = { onOpenTask(task.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("PLAN APPROVAL", style = MaterialTheme.typography.labelMedium, color = p.violet)
                    Spacer(Modifier.weight(1f))
                    StatusPill(task.status, StatusDomain.Task)
                }
                Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                task.planMessage?.let { pm ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Avatar(pm.authorAlias ?: "?", human = false, size = AvatarSize.Sm)
                        Text("${pm.authorAlias ?: "agent"} proposes a plan", style = MaterialTheme.typography.bodyMedium, color = p.text2)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve plan", { onPlanSheet(task) }, Modifier.weight(1f), small = true)
                    DangerTonalButton("Reject…", { onPlanSheet(task) }, Modifier.weight(1f), small = true)
                }
            }
        }
        items(verifications, key = { "verify-${it.id}" }) { task ->
            OrchaCard(onClick = { onOpenTask(task.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("VERIFY TASK", style = MaterialTheme.typography.labelMedium, color = p.ok)
                    Spacer(Modifier.weight(1f))
                    StatusPill(task.status, StatusDomain.Task)
                }
                Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                task.definitionOfDone?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Accept", { onVerifySheet(task) }, Modifier.weight(1f), small = true)
                    DangerTonalButton("Reject…", { onVerifySheet(task) }, Modifier.weight(1f), small = true)
                }
            }
        }
        items(requestsForMe, key = { "req-${it.id}" }) { req ->
            OrchaCard(onClick = { onOpenRequest(req.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("REQUEST FOR YOU", style = MaterialTheme.typography.labelMedium, color = p.info)
                    Spacer(Modifier.weight(1f))
                    StatusPill(req.status, StatusDomain.Request)
                }
                Text("“${req.payload}”", style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Avatar(req.requesterAlias ?: "?", human = false, size = AvatarSize.Sm)
                    Text(
                        "${req.requesterAlias ?: "agent"} → you${MobileUx.agoLabel(req.createdAt)?.let { " · $it" } ?: ""}",
                        style = MaterialTheme.typography.bodyMedium, color = p.text2,
                    )
                    Spacer(Modifier.weight(1f))
                    PrimaryButton("Respond", { onOpenRequest(req.id) }, small = true)
                }
            }
        }

        item { SectionH("Agents", "${snapshot.agents.size}") }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(MobileUx.orderAgents(snapshot.agents.filter { it.kind == "ai" }), key = { it.id }) { agent ->
                    OrchaCard(Modifier.width(176.dp), onClick = { onOpenAgent(agent.id) }) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Avatar(agent.alias, human = false, size = AvatarSize.Sm)
                            Column {
                                Text(agent.alias, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                                StatusPill(agent.status ?: "idle", StatusDomain.Agent)
                            }
                        }
                    }
                }
            }
        }

        item { SectionH("Tasks") }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "in_progress")}", "In progress", p.accent, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "needs_verification")}", "Needs verify", p.violet, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "blocked")}", "Blocked", p.warn, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "completed")}", "Done", p.ok, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
            }
        }

        val activity = snapshot.tasks
            .mapNotNull { t -> t.messageSummary?.last?.let { m -> t to m } }
            .sortedByDescending { it.second.createdAt ?: "" }
            .take(8)
        if (activity.isNotEmpty()) {
            item { SectionH("Activity") }
            items(activity, key = { "act-${it.first.id}-${it.second.messageId ?: it.second.createdAt}" }) { (task, msg) ->
                OrchaCard(onClick = { onOpenTask(task.id) }) {
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(msg.authorAlias ?: if (msg.isHuman) "H" else "?", human = msg.isHuman, size = AvatarSize.Sm)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row {
                                Text(msg.authorAlias ?: if (msg.isHuman) "you" else "system", style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.weight(1f))
                                Text(MobileUx.agoLabel(msg.createdAt) ?: "", style = MonoSmStyle, color = p.faint)
                            }
                            Text(msg.body, style = MaterialTheme.typography.bodyMedium, color = p.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
        state.error?.let { item { Banner(BannerKind.Danger, it) } }
        item { Spacer(Modifier.height(72.dp)) } // FAB clearance
    }
}

/* ---------- Tasks tab (flow 05 T1): chips + grouped list ---------- */

@Composable
private fun TasksTab(tasks: List<TaskDto>, agents: List<AgentDto>, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    var filter by rememberSaveable { mutableStateOf("All") }
    var expandedTerminals by rememberSaveable { mutableStateOf(false) }
    val aiAgents = agents.filter { it.kind == "ai" }

    val filtered = when (filter) {
        "All" -> tasks
        "Needs me" -> MobileUx.needsMe(tasks)
        else -> tasks.filter { it.assignees.contains(filter) || it.ownerAlias == filter }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
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
                items(rows.sortedWith(compareBy<TaskDto> { it.priority ?: 100 }.thenByDescending { it.createdAt ?: "" }), key = { it.id }) { task ->
                    TaskRow(task, onOpenTask)
                }
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

/* ---------- Requests tab (flow 07 R1): the four binding groups ---------- */

@Composable
private fun RequestsTab(
    groups: io.openorcha.mobile.domain.RequestGroups,
    agents: List<AgentDto>,
    humanId: String?,
    onOpenRequest: (String) -> Unit,
) {
    val p = Orcha.palette
    var showDone by rememberSaveable { mutableStateOf(false) }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        fun androidx.compose.foundation.lazy.LazyListScope.group(title: String, rows: List<RequestDto>) {
            if (rows.isEmpty()) return
            item(key = "h-$title") { SectionH(title, "${rows.size}") }
            items(rows, key = { it.id }) { req -> RequestRow(req, humanId, onOpenRequest) }
        }
        group("Needs your answer", groups.needsYourAnswer)
        group("Waiting on others", groups.waitingOnOthers)
        group("Answered — act on it", groups.answeredActOnIt)
        if (groups.done.isNotEmpty()) {
            item(key = "h-done") {
                SectionH("Done", "${groups.done.size}", trailing = {
                    Text(
                        if (showDone) "hide" else "show",
                        style = MaterialTheme.typography.labelMedium, color = p.accent,
                        modifier = Modifier.clickable { showDone = !showDone },
                    )
                })
            }
            if (showDone) items(groups.done, key = { it.id }) { req -> RequestRow(req, humanId, onOpenRequest) }
        }
        if (groups.needsYourAnswer.isEmpty() && groups.waitingOnOthers.isEmpty() && groups.answeredActOnIt.isEmpty() && groups.done.isEmpty()) {
            item { OrchaCard { Text("You're all caught up — no requests involve you.", color = p.muted) } }
        }
    }
}

@Composable
fun RequestRow(req: RequestDto, humanId: String?, onOpenRequest: (String) -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = { onOpenRequest(req.id) }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Avatar(req.requesterAlias ?: "?", human = req.requesterId == humanId, size = AvatarSize.Sm)
            Text("→", color = p.faint)
            Avatar(
                if (req.targetId == null) "H" else req.targetAlias ?: "?",
                human = req.targetId == humanId || req.targetId == null,
                size = AvatarSize.Sm,
            )
            Text(
                "${if (req.requesterId == humanId) "you" else req.requesterAlias ?: "agent"} → ${if (req.targetId == humanId || req.targetId == null) "you" else req.targetAlias ?: "agent"}",
                style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(req.payload, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(req.status, StatusDomain.Request)
            MetaTag(req.type)
            if (req.chainDepth > 0) MetaTag("↳ chain")
            Spacer(Modifier.weight(1f))
            Text(MobileUx.agoLabel(req.createdAt) ?: "", style = MonoSmStyle, color = p.faint)
        }
    }
}

/* ---------- Agents tab (flow 09 A1): roster + humans section ---------- */

@Composable
private fun AgentsTab(agents: List<AgentDto>, onOpenAgent: (String) -> Unit) {
    val p = Orcha.palette
    val ai = MobileUx.orderAgents(agents.filter { it.kind == "ai" })
    val humans = agents.filter { it.kind == "human" }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { SectionH("Agents", "${ai.size}") }
        items(ai, key = { it.id }) { agent ->
            val dead = agent.status == "terminated"
            OrchaCard(
                modifier = Modifier.alpha(if (dead) 0.55f else 1f),
                onClick = { onOpenAgent(agent.id) },
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Avatar(agent.alias, human = false)
                    Column(Modifier.weight(1f)) {
                        Text(agent.alias, style = MaterialTheme.typography.titleSmall)
                        Text(agent.role ?: "agent", style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    StatusPill(agent.status ?: "idle", StatusDomain.Agent)
                }
                if (agent.status == "working") {
                    agent.currentTask?.title?.let {
                        Text("▸ $it", style = MaterialTheme.typography.bodyMedium, color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    agent.model?.let { MetaTag(it, mono = true) }
                    Spacer(Modifier.weight(1f))
                    Text(MobileUx.agoLabel(agent.lastActive) ?: "", style = MonoSmStyle, color = p.faint)
                }
            }
        }
        if (humans.isNotEmpty()) {
            item { SectionH("Humans", "${humans.size}") }
            items(humans, key = { it.id }) { h ->
                OrchaCard(onClick = { onOpenAgent(h.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(h.alias, human = true)
                        Column(Modifier.weight(1f)) {
                            Text(h.alias, style = MaterialTheme.typography.titleSmall)
                            Text("Human authority", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                        }
                    }
                }
            }
        }
        if (ai.isEmpty() && humans.isEmpty()) {
            item { OrchaCard { Text("No agents yet — create agents from the portal's onboarding.", color = p.muted) } }
        }
    }
}

/* =============================================================================
   Flow 08 — the approval sheets. Plan text / DoD render in full (never truncated);
   Request-changes / Send-back expand a REQUIRED feedback field.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanApprovalSheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onDecide: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("PLAN APPROVAL", style = MaterialTheme.typography.labelMedium, color = p.violet)
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            task.planMessage?.let { pm ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Avatar(pm.authorAlias ?: "?", human = false, size = AvatarSize.Sm)
                    Text("${pm.authorAlias ?: "agent"} proposes a plan", style = MaterialTheme.typography.bodyMedium, color = p.text2)
                }
            }
            SectionH("Proposed plan")
            OrchaCard(container = p.surface2) {
                LazyColumn(Modifier.height(240.dp)) {
                    item { Text(task.planMessage?.body ?: "No plan text found on the thread.", color = p.text, style = MaterialTheme.typography.bodyLarge) }
                }
            }
            if (rejecting) {
                OrchaField(reason, { reason = it }, label = "What should change?", minLines = 3, supporting = "${task.planMessage?.authorAlias ?: "The agent"} sees this on the next wake — required.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DangerTonalButton("Send back with changes", { onDecide(false, reason.trim()) }, Modifier.weight(1f), enabled = reason.isNotBlank() && !busy)
                    NeutralButton("Cancel", { rejecting = false }, enabled = !busy)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve plan", { onDecide(true, null) }, Modifier.weight(1f), enabled = !busy)
                    DangerTonalButton("Request changes…", { rejecting = true }, Modifier.weight(1f), enabled = !busy)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerifySheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onVerify: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("VERIFY TASK", style = MaterialTheme.typography.labelMedium, color = p.ok)
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            SectionH("Definition of done")
            OrchaCard(container = p.surface2, borderColor = p.okLine) {
                Text(task.definitionOfDone ?: "No definition of done was provided.", color = p.text, style = MaterialTheme.typography.bodyLarge)
            }
            (task.result ?: task.messageSummary?.last?.body)?.let {
                SectionH("Claimed result")
                OrchaCard(container = p.surface2) {
                    Text(it, color = p.text2, style = MaterialTheme.typography.bodyLarge, maxLines = 8, overflow = TextOverflow.Ellipsis)
                }
            }
            if (rejecting) {
                OrchaField(feedback, { feedback = it }, label = "What's missing?", minLines = 3, supporting = "Returns the task to in progress — required.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DangerTonalButton("Send back", { onVerify(false, feedback.trim()) }, Modifier.weight(1f), enabled = feedback.isNotBlank() && !busy)
                    NeutralButton("Cancel", { rejecting = false }, enabled = !busy)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve & complete", { onVerify(true, null) }, Modifier.weight(1f), enabled = !busy)
                    NeutralButton("Send back with feedback…", { rejecting = true }, Modifier.weight(1f), enabled = !busy)
                }
            }
        }
    }
}
