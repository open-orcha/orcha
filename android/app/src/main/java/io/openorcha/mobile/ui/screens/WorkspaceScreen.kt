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
import androidx.compose.runtime.collectAsState
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
    onOpenGithubHub: () -> Unit = {},
    onSearchQueryChange: (String) -> Unit = {},
    /** Project switcher target; null hides the per-project list (only "All projects"). */
    onSwitchProject: ((String) -> Unit)? = null,
    /** Workflows tab state (design #373); null keeps the tab on its Tasks segment only. */
    workflows: io.openorcha.mobile.ui.WorkflowsController? = null,
) {
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

    var planSheetTask by remember { mutableStateOf<TaskDto?>(null) }
    var verifySheetTask by remember { mutableStateOf<TaskDto?>(null) }
    var controlsSheetOpen by remember { mutableStateOf(false) }
    var metricsOpen by remember { mutableStateOf(false) }

    val dotState = workspaceDotState(snapshot != null, state.loading, containerPaused)
    val running = !containerPaused && wakesEnabled
    Scaffold(
        containerColor = Orcha.palette.bg,
        topBar = {
            WorkspaceTopBar(
                projectName = selected?.displayName ?: "Embodent",
                containers = state.containers,
                selectedId = selected?.id,
                icons = state.containerHealth.mapValues { it.value.icon } +
                    listOfNotNull(snapshot?.let { it.container.id to it.container.projectIcon }),
                dotState = dotState,
                showExecution = snapshot != null,
                running = running,
                // The Workflows tab has its own per-segment FAB (New workflow / New task, design §2).
                showCreate = snapshot != null && state.selectedTab == WorkspaceTab.Home,
                onBack = onBack,
                onSwitchProject = onSwitchProject,
                onAllProjects = onBack,
                onControls = { controlsSheetOpen = true },
                onCreateTask = onCreateTask,
                onSettings = onSettings,
                onDisconnect = onForget,
                onOpenMetrics = { metricsOpen = true },
            )
        },
        bottomBar = {
            WorkspaceBottomBar(
                selected = state.selectedTab,
                dests = listOf(
                    WorkspaceNavDest(WorkspaceTab.Home, "Home", OrchaIcons.Home, needsYou.total),
                    WorkspaceNavDest(WorkspaceTab.Workflows, "Workflows", OrchaIcons.Workflow, 0),
                    WorkspaceNavDest(WorkspaceTab.Requests, "Requests", OrchaIcons.Inbox, requestGroups.badgeCount),
                    WorkspaceNavDest(WorkspaceTab.Agents, "Agents", OrchaIcons.SmartToy, 0),
                    WorkspaceNavDest(WorkspaceTab.Search, "Search", OrchaIcons.Search, 0),
                ),
                onTab = onTab,
            )
        },
    ) { padding ->
        when {
            snapshot == null && state.loading -> WorkspaceSkeleton(Modifier.padding(padding))
            snapshot == null -> StateLayout(
                title = "Can't reach this project",
                sub = "${selected?.baseUrl ?: "The container"} didn't answer. Your work is safe — the phone just can't see it right now.",
                modifier = Modifier.padding(padding),
                danger = true,
                glyph = { Icon(OrchaIcons.WifiOff, null, tint = Orcha.palette.danger) },
            ) {
                io.openorcha.mobile.ui.components.LCard {
                    Text("1  Are you online? The portal needs an internet connection.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("2  Is the deployment up — or, self-hosting, is the computer awake with Embodent running?", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                    Text("3  Access token rotated? Update it in Settings → Containers.", style = MaterialTheme.typography.bodyMedium, color = Orcha.palette.text2)
                }
                io.openorcha.mobile.ui.components.LButton("Try again", onRefresh)
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
                        "This project is paused or stopped on the laptop — resume it there to continue.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                } else if (notifierPaused) {
                    Banner(
                        BannerKind.Warn,
                        "Notifier paused — agents won't wake.",
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        action = "Resume",
                        onAction = { controlsSheetOpen = true },
                    )
                }
                val refreshAll = {
                    onRefresh()
                    // Pull-to-refresh on the Workflows segment resets the list cursor (W01) or re-reads the open detail.
                    if (state.selectedTab == WorkspaceTab.Workflows) workflows?.let { w ->
                        if (w.state.value.openWorkflowId != null) w.refreshDetail() else w.refreshList()
                    }
                }
                // W17: Home lists workflows waiting on an owner decision; binding reads the list once per container.
                androidx.compose.runtime.LaunchedEffect(state.selectedContainer?.id, state.selectedContainer?.humanAgentId) {
                    workflows?.bind(state.selectedContainer)
                }
                val workflowDecisions = workflows?.state?.collectAsState()?.value?.loaded.orEmpty()
                    .filter { !it.hidden && io.openorcha.mobile.domain.WorkflowLogic.needsDecision(it) }
                PullToRefreshBox(isRefreshing = state.loading, onRefresh = refreshAll, modifier = Modifier.weight(1f)) {
                when (state.selectedTab) {
                    WorkspaceTab.Home -> HomeTab(
                        state, needsYou.planApprovals, needsYou.verifications, needsYou.requests,
                        onOpenTask, onOpenRequest, onOpenAgent, onTab,
                        onPlanSheet = { planSheetTask = it }, onVerifySheet = { verifySheetTask = it },
                        onOpenGithubHub = onOpenGithubHub,
                        onOpenMetrics = { metricsOpen = true },
                        ownerDecisions = workflowDecisions,
                        onOpenWorkflow = { id ->
                            workflows?.selectSegment(io.openorcha.mobile.ui.WorkflowsSegment.Workflows)
                            workflows?.openWorkflow(id)
                            onTab(WorkspaceTab.Workflows)
                        },
                    )
                    WorkspaceTab.Workflows -> WorkflowsTab(
                        controller = workflows,
                        snapshot = snapshot,
                        container = state.selectedContainer,
                        onOpenTask = onOpenTask,
                        onCreateTask = onCreateTask,
                        onTaskChanged = onRefresh,
                    )
                    WorkspaceTab.Requests -> RequestsTab(snapshot.requests, snapshot.agents, humanId, onOpenRequest)
                    WorkspaceTab.Agents -> AgentsTab(snapshot.agents, onOpenAgent, baseUrl = selected?.baseUrl, containerId = selected?.id)
                    WorkspaceTab.Search -> SearchTab(
                        snapshot = snapshot,
                        humanId = humanId,
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

    selected?.takeIf { metricsOpen }?.let { sel ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { metricsOpen = false },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) { ProjectMetricsScreen(sel, onBack = { metricsOpen = false }) }
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
        // W17 / §8: a workflow member's verification goes through the W09 result review; the
        // legacy verify sheet is for non-members only, and unknown membership is never "non-member".
        val ws = workflows?.state?.collectAsState()?.value
        androidx.compose.runtime.LaunchedEffect(task.id) { workflows?.resolveMembership(task.id) }
        val membership = if (workflows == null || ws == null) io.openorcha.mobile.ui.TaskMembership.None else workflows.membership(task.id)
        when (membership) {
            is io.openorcha.mobile.ui.TaskMembership.Member -> androidx.compose.runtime.LaunchedEffect(membership.workflow.id) {
                verifySheetTask = null
                workflows?.openResultReview(membership.workflow.id, task.id)
                onTab(WorkspaceTab.Workflows)
            }
            io.openorcha.mobile.ui.TaskMembership.None -> VerifySheet(
                task = task,
                busy = state.actionInFlight,
                onDismiss = { verifySheetTask = null },
                onVerify = { approve, feedback -> verifySheetTask = null; onVerifyFor(task.id, approve, feedback) },
            )
            else -> WorkflowMembershipSheet(
                membership,
                onRetry = { workflows?.resolveMembership(task.id, force = true) },
                onDismiss = { verifySheetTask = null },
            )
        }
    }
    if (controlsSheetOpen) {
        ContainerControlsSheet(
            wakesEnabled = wakesEnabled,
            containerActive = !containerPaused,
            canAct = humanId != null,
            busy = state.actionInFlight,
            onDismiss = { controlsSheetOpen = false },
            onSetWakes = onSetWakes,
        )
    }
}
