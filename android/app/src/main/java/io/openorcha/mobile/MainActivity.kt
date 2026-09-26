package io.openorcha.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubIssueDetailPhase
import io.openorcha.mobile.domain.GitHubPullDetailPhase
import io.openorcha.mobile.ui.AppRoute
import io.openorcha.mobile.ui.OrchaViewModel
import io.openorcha.mobile.ui.screens.AgentDetailScreen
import io.openorcha.mobile.ui.screens.ContainersHomeScreen
import io.openorcha.mobile.ui.screens.ConversationScreen
import io.openorcha.mobile.ui.screens.CreateTaskScreen
import io.openorcha.mobile.ui.screens.GitHubHubScreen
import io.openorcha.mobile.ui.screens.GitHubIssueDetailScreen
import io.openorcha.mobile.ui.screens.GitHubPullDetailScreen
import io.openorcha.mobile.ui.screens.ManualConnectScreen
import io.openorcha.mobile.ui.screens.RequestDetailScreen
import io.openorcha.mobile.ui.screens.RunDetailScreen
import io.openorcha.mobile.ui.screens.ScannerScreen
import io.openorcha.mobile.ui.screens.SettingsScreen
import io.openorcha.mobile.ui.screens.TaskDetailScreen
import io.openorcha.mobile.ui.screens.TaskThreadScreen
import io.openorcha.mobile.ui.screens.WorkspaceScreen
import io.openorcha.mobile.ui.theme.OrchaTheme

class MainActivity : ComponentActivity() {
    private val viewModel: OrchaViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        routeAuthCallback(intent)
        enableEdgeToEdge()
        setContent {
            val state by viewModel.uiState.collectAsState()
            OrchaTheme(mode = state.themeMode, skin = state.skinMode) {
                // Snackbar feedback for every VM toast ("Task verified", "Answer sent", …)
                val snackbarHost = remember { SnackbarHostState() }
                LaunchedEffect(state.toast) {
                    val toast = state.toast
                    if (toast != null) {
                        viewModel.clearToast()
                        snackbarHost.showSnackbar(toast)
                    }
                }
                // A GitHub Start (hub list, or either detail screen) hands back the
                // created/already-tracked task; navigate to it once, mirroring iOS's
                // `navigationDestination(item: $startedTaskId)`.
                LaunchedEffect(state.githubStarted) {
                    val started = state.githubStarted
                    if (started != null) {
                        viewModel.clearGithubStarted()
                        viewModel.openTask(started.taskId)
                    }
                }
                // Predictive/system back navigates the internal route stack (IA doc §3):
                // detail → tab root → containers home → (system default exits).
                BackHandler(enabled = state.route != AppRoute.Containers) {
                    when (state.route) {
                        AppRoute.TaskThread -> viewModel.backToTaskDetail()
                        AppRoute.RunDetail, AppRoute.Conversation ->
                            state.selectedAgent?.let { viewModel.openAgent(it.id) } ?: viewModel.showWorkspace()
                        AppRoute.GitHubIssueDetail, AppRoute.GitHubPullDetail -> viewModel.showGithubHub()
                        AppRoute.TaskDetail, AppRoute.RequestDetail, AppRoute.AgentDetail, AppRoute.CreateTask, AppRoute.GitHubHub ->
                            viewModel.showWorkspace()
                        AppRoute.Workspace, AppRoute.AddContainer, AppRoute.Settings, AppRoute.Scanner ->
                            viewModel.showContainers()
                        AppRoute.Containers -> Unit
                    }
                }
                Box(Modifier.fillMaxSize().paletteChromeBackground()) {
                when (state.route) {
                    AppRoute.Containers -> ContainersHomeScreen(
                        state = state,
                        onAdd = viewModel::showAddContainer,
                        onScan = viewModel::showScanner,
                        onOpen = viewModel::openContainer,
                        onForget = viewModel::forgetContainer,
                        onRename = viewModel::renameContainer,
                        onRefresh = viewModel::probeContainers,
                        onSettings = viewModel::showSettings,
                    )

                    AppRoute.Scanner -> ScannerScreen(
                        onBack = viewModel::showContainers,
                        onPayload = viewModel::connectScanned,
                        onManualEntry = viewModel::showAddContainer,
                    )

                    AppRoute.AddContainer -> ManualConnectScreen(
                        state = state,
                        onBack = {
                            viewModel.resetDeviceAuth()
                            viewModel.showContainers()
                        },
                        onScan = viewModel::showScanner,
                        onConnect = { viewModel.connectManual(it) },
                        onSignIn = { viewModel.signInWithGitHub(this@MainActivity) },
                        onConnectWithToken = { rawBaseUrl, token -> viewModel.connectWithAccessToken(rawBaseUrl, token) },
                    )

                    AppRoute.Settings -> SettingsScreen(
                        state = state,
                        onBack = viewModel::showContainers,
                        onTheme = viewModel::setThemeMode,
                        onSkin = viewModel::setSkinMode,
                        onOpen = viewModel::openContainer,
                        onForget = viewModel::forgetContainer,
                        onAdd = viewModel::showAddContainer,
                        onSetRemoteUrl = viewModel::setRemoteUrl,
                        onSetAccessToken = viewModel::setContainerAccessToken,
                        onSignInAgain = { id ->
                            viewModel.beginSignInAgain(id)
                            viewModel.signInWithGitHub(this@MainActivity)
                        },
                    )

                    AppRoute.Workspace -> WorkspaceScreen(
                        state = state,
                        onBack = viewModel::showContainers,
                        onRefresh = viewModel::refreshSelected,
                        onForget = viewModel::forgetSelectedContainer,
                        onSettings = viewModel::showSettings,
                        onTab = viewModel::selectTab,
                        onOpenTask = viewModel::openTask,
                        onOpenRequest = viewModel::openRequest,
                        onOpenAgent = viewModel::openAgent,
                        onCreateTask = viewModel::showCreateTask,
                        onDecidePlanFor = viewModel::decidePlanById,
                        onVerifyFor = viewModel::verifyTaskById,
                        onSetWakes = viewModel::setWakes,
                        onSetAutonomy = viewModel::setAutonomy,
                        onOpenGithubHub = viewModel::showGithubHub,
                        onSearchQueryChange = viewModel::setSearchQuery,
                    )

                    AppRoute.TaskDetail -> TaskDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRefresh = viewModel::refreshSelectedTask,
                        onOpenThread = viewModel::openThread,
                        onOpenTask = viewModel::openTask,
                        onPrepareClose = viewModel::fetchCloseImplications,
                        onCancelTask = viewModel::cancelSelectedTask,
                        onVerify = viewModel::verifySelectedTask,
                        onDecidePlan = viewModel::decideSelectedPlan,
                        onOpenRun = viewModel::openRun,
                    )

                    AppRoute.TaskThread -> TaskThreadScreen(
                        state = state,
                        onBack = viewModel::backToTaskDetail,
                        onRefresh = viewModel::refreshSelectedTask,
                        onSendMessage = viewModel::sendTaskMessage,
                        onLoadEarlier = viewModel::loadEarlierMessages,
                        onOpenTask = viewModel::openTask,
                    )

                    AppRoute.RequestDetail -> RequestDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRespond = viewModel::respondSelectedRequest,
                        onClose = viewModel::closeSelectedRequest,
                        onNudge = viewModel::nudgeSelectedRequest,
                        onEscalate = viewModel::escalateSelectedRequest,
                        onAcceptTask = viewModel::acceptSelectedTaskRequest,
                        onRejectTask = viewModel::rejectSelectedTaskRequest,
                        onConvert = viewModel::convertSelectedRequest,
                        onOpenTask = viewModel::openTask,
                    )

                    AppRoute.AgentDetail -> AgentDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRefresh = viewModel::refreshAgentDetail,
                        onConversation = viewModel::openConversation,
                        onModel = viewModel::changeSelectedAgentModel,
                        onAutoWake = viewModel::changeSelectedAgentAutoWake,
                        onRetire = viewModel::retireSelectedAgent,
                        onRename = viewModel::renameSelectedAgent,
                        onOpenTask = viewModel::openTask,
                        onOpenRun = viewModel::openRun,
                        onOpenRequests = {
                            viewModel.selectTab(io.openorcha.mobile.ui.WorkspaceTab.Requests)
                            viewModel.showWorkspace()
                        },
                    )

                    AppRoute.RunDetail -> RunDetailScreen(
                        state = state,
                        onBack = {
                            if (state.selectedAgent != null) viewModel.openAgent(state.selectedAgent!!.id) else viewModel.showWorkspace()
                        },
                        onRefresh = viewModel::refreshRunLog,
                        onStop = viewModel::stopSelectedRun,
                    )

                    AppRoute.Conversation -> ConversationScreen(
                        state = state,
                        onBack = {
                            if (state.selectedAgent != null) viewModel.openAgent(state.selectedAgent!!.id) else viewModel.showWorkspace()
                        },
                        onRefresh = viewModel::refreshConversation,
                        onSend = viewModel::sendConversationTurn,
                        onEnd = viewModel::endConversation,
                        onOpenRun = viewModel::openRun,
                        onOpenTask = viewModel::openTask,
                        onRetry = viewModel::takeFailedSendContent,
                    )

                    AppRoute.CreateTask -> CreateTaskScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onCreate = viewModel::createTask,
                    )

                    AppRoute.GitHubHub -> GitHubHubScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onSelectKind = viewModel::selectGithubHubKind,
                        onSelectFilter = viewModel::selectGithubHubFilter,
                        onRefresh = {
                            viewModel.loadGithubIssues()
                            viewModel.loadGithubPulls()
                        },
                        onOpenIssue = viewModel::openGithubIssue,
                        onOpenPull = viewModel::openGithubPull,
                        onStartIssue = { issue, agentId ->
                            viewModel.startGithubItem(
                                kind = GitHubHubKind.Issues, number = issue.number,
                                title = issue.title, bodyExcerpt = issue.bodyExcerpt, htmlUrl = issue.htmlUrl,
                                assigneeAgentId = agentId,
                            )
                        },
                        onStartPull = { pull, agentId ->
                            viewModel.startGithubItem(
                                kind = GitHubHubKind.Pulls, number = pull.number,
                                title = pull.title, bodyExcerpt = null, htmlUrl = pull.htmlUrl,
                                assigneeAgentId = agentId,
                            )
                        },
                        onPullsAuthorChange = viewModel::setGithubPullsAuthor,
                        onPullsQueryChange = viewModel::setGithubPullsQuery,
                        onSelectPullsInvolvement = viewModel::selectGithubPullsInvolvement,
                        onLoadMorePulls = viewModel::loadMoreGithubPulls,
                    )

                    AppRoute.GitHubIssueDetail -> GitHubIssueDetailScreen(
                        state = state,
                        onBack = viewModel::showGithubHub,
                        onRefresh = viewModel::loadGithubIssueDetail,
                        onStart = { agentId ->
                            val issue = (state.githubIssueDetailPhase as? GitHubIssueDetailPhase.Loaded)?.issue
                            if (issue != null) {
                                viewModel.startGithubItem(
                                    kind = GitHubHubKind.Issues, number = issue.number,
                                    title = issue.title, bodyExcerpt = issue.bodyMarkdown.take(200), htmlUrl = issue.htmlUrl,
                                    assigneeAgentId = agentId,
                                )
                            }
                        },
                    )

                    AppRoute.GitHubPullDetail -> GitHubPullDetailScreen(
                        state = state,
                        onBack = viewModel::showGithubHub,
                        onRefresh = viewModel::loadGithubPullDetail,
                        onStart = { agentId ->
                            val pull = (state.githubPullDetailPhase as? GitHubPullDetailPhase.Loaded)?.pull
                            if (pull != null) {
                                viewModel.startGithubItem(
                                    kind = GitHubHubKind.Pulls, number = pull.number,
                                    title = pull.title, bodyExcerpt = null, htmlUrl = pull.htmlUrl,
                                    assigneeAgentId = agentId,
                                )
                            }
                        },
                    )
                }
                SnackbarHost(
                    hostState = snackbarHost,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 90.dp),
                )
                }
            }
        }
    }

    /**
     * Device-token auth: `singleTask` (manifest) keeps one MainActivity instance,
     * so the GitHub sign-in Custom Tab's `orcha://auth/callback` redirect arrives
     * here rather than starting a second Activity on top of the in-flight flow.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        routeAuthCallback(intent)
    }

    /**
     * `orcha://auth/...` belongs to the device-token flow -- hand it to the shared
     * [DeviceAuthSession] rather than routing it as a normal deep link. A stray
     * delivery (e.g. a relaunch from the recents tray after the session already
     * finished) is simply a no-op: [DeviceAuthSession.onCallback] only resumes a
     * suspend call that's actually waiting.
     */
    private fun routeAuthCallback(intent: Intent?) {
        val uri = intent?.data ?: return
        if (io.openorcha.mobile.ui.DeviceAuthSession.isAuthCallbackIntent(intent)) {
            viewModel.deviceAuthSession.onCallback(uri)
        }
    }
}

/**
 * Classic-skin radial background chrome (iOS `PaletteEnvironment` parity): two faint
 * brand radial gradients from `bgGrad1`/`bgGrad2` behind the whole app, honoring the
 * palette's `flatChrome` flag — Swiss/Minimal stay flat (the portal's `--bg-grad-*:
 * transparent`), Classic keeps the portal's glow. Painted on the root `Box`; each
 * screen's own `Scaffold(containerColor = Orcha.palette.bg)` currently paints an
 * opaque background over it, so this radial is architecturally in place but not
 * yet visible behind screen content — making it show through means moving every
 * screen's Scaffold to a transparent container color, out of this wave's scope
 * (root composable only).
 */
@Composable
private fun Modifier.paletteChromeBackground(): Modifier {
    val p = Orcha.palette
    val flat = p.flatChrome
    val bg = p.bg
    val grad1 = p.bgGrad1
    val grad2 = p.bgGrad2
    return this.background(bg).then(
        if (flat) {
            Modifier
        } else {
            Modifier.drawWithCache {
                // iOS PaletteEnvironment parity: fractional centers (0.15, 0.0) and
                // (1.0, 0.1) of the canvas, radii 500/450dp — resolved against the
                // actual draw size (radialGradient's `center` is pixel-absolute).
                val radius1 = 500.dp.toPx()
                val radius2 = 450.dp.toPx()
                val brush1 = Brush.radialGradient(
                    colors = listOf(grad1, Color.Transparent),
                    center = Offset(size.width * 0.15f, 0f),
                    radius = radius1,
                )
                val brush2 = Brush.radialGradient(
                    colors = listOf(grad2, Color.Transparent),
                    center = Offset(size.width * 1f, size.height * 0.1f),
                    radius = radius2,
                )
                onDrawBehind {
                    drawRect(brush1)
                    drawRect(brush2)
                }
            }
        },
    )
}
