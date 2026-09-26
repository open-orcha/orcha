package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.ConnChip
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Container workspace scaffold: top bar, bottom nav, tab routing, connection-state
   banners, and the plan-approval / verify / container-controls sheets it can open.
   Tab bodies live in WorkspaceHomeTab.kt / WorkspaceTasksTab.kt / WorkspaceRequestsTab.kt
   / WorkspaceAgentsTab.kt; nav-item and skeleton pieces live in WorkspaceScaffoldParts.kt. */

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
    onSetWakes: (Boolean) -> Unit,
    onSetAutonomy: (String) -> Unit,
    onOpenGithubHub: () -> Unit = {},
    onSearchQueryChange: (String) -> Unit = {},
) {
    var menuOpen by remember { mutableStateOf(false) }
    val snapshot = state.snapshot
    val selected = state.selectedContainer
    val humanId = selected?.humanAgentId
    val needsYou = OrchaSelectors.needsYou(snapshot)
    val requestGroups = MobileUx.requestGroups(snapshot?.requests.orEmpty(), humanId)
    // GH #148: two orthogonal states. `containerPaused` is the laptop-level lifecycle
    // (/orcha-pause) — a separate, higher tier than the in-container notifier switch.
    val containerPaused = snapshot != null && snapshot.container.status != "active"
    val wakesEnabled = snapshot?.container?.wakesEnabled ?: true
    val notifierPaused = snapshot != null && !wakesEnabled
    val autonomyLevel = snapshot?.container?.autonomyLevel ?: "plan"

    var planSheetTask by remember { mutableStateOf<TaskDto?>(null) }
    var verifySheetTask by remember { mutableStateOf<TaskDto?>(null) }
    var controlsSheetOpen by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(selected?.displayName ?: "Orcha", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        ConnChip(if (snapshot == null) (if (state.loading) "probing" else "unreachable") else if (containerPaused) "paused" else "polling")
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = {
                    if (snapshot != null) {
                        IconButton(onClick = { controlsSheetOpen = true }) { Icon(OrchaIcons.Settings, "Container controls") }
                    }
                    IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More") }
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
                WorkspaceNavItem(state, WorkspaceTab.Home, "Home", OrchaIcons.Home, badge = needsYou.total, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Tasks, "Tasks", OrchaIcons.Checklist, badge = 0, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Requests, "Requests", OrchaIcons.Forum, badge = requestGroups.badgeCount, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Agents, "Agents", OrchaIcons.SmartToy, badge = 0, onTab)
                WorkspaceNavItem(state, WorkspaceTab.Search, "Search", OrchaIcons.Search, badge = 0, onTab)
            }
        },
        floatingActionButton = {
            if (state.selectedTab == WorkspaceTab.Home || state.selectedTab == WorkspaceTab.Tasks) {
                FloatingActionButton(
                    onClick = onCreateTask,
                    containerColor = Orcha.palette.accent,
                    contentColor = Orcha.palette.accentInk,
                ) { Icon(OrchaIcons.Add, "Create task") }
            }
        },
    ) { padding ->
        when {
            snapshot == null && state.loading -> WorkspaceSkeleton(Modifier.padding(padding))
            snapshot == null -> StateLayout(
                title = "Can't reach this Orcha",
                sub = "${selected?.baseUrl ?: "The container"} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(OrchaIcons.WifiOff, null, tint = Orcha.palette.danger) },
            ) {
                OrchaCard {
                    Text("1  Are you online? The portal needs an internet connection.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("2  Is the deployment up — or, self-hosting, is the computer awake with Orcha running?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("3  Access token rotated? Update it in Settings → Containers.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                }
                NeutralButton("Try again", onRefresh)
            }
            else -> Column(Modifier.padding(padding)) {
                // connection-model banners (flow 04 H8/H10): polling is the honest v1
                // state (SSE is a listed follow-up). GH #148: laptop-level container-pause
                // is a separate, higher tier than the in-container notifier switch — never
                // conflate the two banners.
                // No steady-state banner: polling is the normal connection model and
                // pull-to-refresh already covers manual refresh — only genuinely
                // abnormal states (paused) warrant a banner.
                if (containerPaused) {
                    Banner(
                        BannerKind.Info,
                        "This Orcha is paused/stopped on the laptop — resume it there before agents can act.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                } else if (notifierPaused) {
                    Banner(
                        BannerKind.Info,
                        "This Orcha is paused — agents won't act until resumed.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        action = "Resume",
                        onAction = { controlsSheetOpen = true },
                    )
                }
                PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
                when (state.selectedTab) {
                    WorkspaceTab.Home -> HomeTab(
                        state, needsYou.planApprovals, needsYou.verifications, needsYou.requests,
                        onOpenTask, onOpenRequest, onOpenAgent, onTab,
                        onPlanSheet = { planSheetTask = it }, onVerifySheet = { verifySheetTask = it },
                        onOpenGithubHub = onOpenGithubHub,
                    )
                    WorkspaceTab.Tasks -> TasksTab(snapshot.tasks, snapshot.agents, onOpenTask)
                    WorkspaceTab.Requests -> RequestsTab(snapshot.requests, snapshot.agents, humanId, onOpenRequest)
                    WorkspaceTab.Agents -> AgentsTab(snapshot.agents, onOpenAgent)
                    WorkspaceTab.Search -> SearchTab(
                        snapshot = snapshot,
                        query = state.searchQuery,
                        onQueryChange = onSearchQueryChange,
                        onOpenTask = onOpenTask,
                        onOpenRequest = onOpenRequest,
                        onOpenAgent = onOpenAgent,
                    )
                }
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
    if (controlsSheetOpen) {
        ContainerControlsSheet(
            wakesEnabled = wakesEnabled,
            autonomyLevel = autonomyLevel,
            containerActive = !containerPaused,
            canAct = humanId != null,
            busy = state.actionInFlight,
            onDismiss = { controlsSheetOpen = false },
            onSetWakes = onSetWakes,
            onSetAutonomy = onSetAutonomy,
        )
    }
}
