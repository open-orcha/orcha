package io.openorcha.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.AppRoute
import io.openorcha.mobile.ui.OrchaViewModel
import io.openorcha.mobile.ui.screens.AgentDetailScreen
import io.openorcha.mobile.ui.screens.ContainersHomeScreen
import io.openorcha.mobile.ui.screens.ConversationScreen
import io.openorcha.mobile.ui.screens.CreateTaskScreen
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
        enableEdgeToEdge()
        setContent {
            val state by viewModel.uiState.collectAsState()
            OrchaTheme(mode = state.themeMode) {
                // Snackbar feedback for every VM toast ("Task verified", "Answer sent", …)
                val snackbarHost = remember { SnackbarHostState() }
                LaunchedEffect(state.toast) {
                    val toast = state.toast
                    if (toast != null) {
                        viewModel.clearToast()
                        snackbarHost.showSnackbar(toast)
                    }
                }
                // Predictive/system back navigates the internal route stack (IA doc §3):
                // detail → tab root → containers home → (system default exits).
                BackHandler(enabled = state.route != AppRoute.Containers) {
                    when (state.route) {
                        AppRoute.TaskThread -> viewModel.backToTaskDetail()
                        AppRoute.RunDetail, AppRoute.Conversation ->
                            state.selectedAgent?.let { viewModel.openAgent(it.id) } ?: viewModel.showWorkspace()
                        AppRoute.TaskDetail, AppRoute.RequestDetail, AppRoute.AgentDetail, AppRoute.CreateTask ->
                            viewModel.showWorkspace()
                        AppRoute.Workspace, AppRoute.AddContainer, AppRoute.Settings, AppRoute.Scanner ->
                            viewModel.showContainers()
                        AppRoute.Containers -> Unit
                    }
                }
                Box(Modifier.fillMaxSize()) {
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
                        onBack = viewModel::showContainers,
                        onScan = viewModel::showScanner,
                        onConnect = viewModel::connectManual,
                    )

                    AppRoute.Settings -> SettingsScreen(
                        state = state,
                        onBack = viewModel::showContainers,
                        onTheme = viewModel::setThemeMode,
                        onOpen = viewModel::openContainer,
                        onForget = viewModel::forgetContainer,
                        onAdd = viewModel::showAddContainer,
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
                        onTriageClose = viewModel::triageCloseSelectedRequest,
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
                    )

                    AppRoute.CreateTask -> CreateTaskScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onCreate = viewModel::createTask,
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
}
