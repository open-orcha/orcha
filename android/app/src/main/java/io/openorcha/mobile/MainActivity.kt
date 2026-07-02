package io.openorcha.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import io.openorcha.mobile.ui.AppRoute
import io.openorcha.mobile.ui.OrchaViewModel
import io.openorcha.mobile.ui.screens.ContainersHomeScreen
import io.openorcha.mobile.ui.screens.AgentDetailScreen
import io.openorcha.mobile.ui.screens.ConversationScreen
import io.openorcha.mobile.ui.screens.CreateTaskScreen
import io.openorcha.mobile.ui.screens.ManualConnectScreen
import io.openorcha.mobile.ui.screens.RequestDetailScreen
import io.openorcha.mobile.ui.screens.RunDetailScreen
import io.openorcha.mobile.ui.screens.TaskDetailScreen
import io.openorcha.mobile.ui.screens.WorkspaceScreen
import io.openorcha.mobile.ui.theme.OrchaTheme

class MainActivity : ComponentActivity() {
    private val viewModel: OrchaViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            OrchaTheme {
                val state by viewModel.uiState.collectAsState()
                when (state.route) {
                    AppRoute.Containers -> ContainersHomeScreen(
                        state = state,
                        onAdd = viewModel::showAddContainer,
                        onOpen = viewModel::openContainer,
                        onForget = viewModel::forgetContainer,
                        onRefresh = viewModel::refreshSelected,
                    )

                    AppRoute.AddContainer -> ManualConnectScreen(
                        state = state,
                        onBack = viewModel::showContainers,
                        onConnect = viewModel::connectManual,
                    )

                    AppRoute.Workspace -> WorkspaceScreen(
                        state = state,
                        onBack = viewModel::showContainers,
                        onRefresh = viewModel::refreshSelected,
                        onForget = viewModel::forgetSelectedContainer,
                        onTab = viewModel::selectTab,
                        onOpenTask = viewModel::openTask,
                        onOpenRequest = viewModel::openRequest,
                        onOpenAgent = viewModel::openAgent,
                        onCreateTask = viewModel::showCreateTask,
                    )

                    AppRoute.TaskDetail -> TaskDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRefresh = viewModel::refreshSelectedTask,
                        onSendMessage = viewModel::sendTaskMessage,
                        onCancelTask = viewModel::cancelSelectedTask,
                        onVerify = viewModel::verifySelectedTask,
                        onDecidePlan = viewModel::decideSelectedPlan,
                        onOpenRun = viewModel::openRun,
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
                    )

                    AppRoute.AgentDetail -> AgentDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRefresh = viewModel::refreshAgentDetail,
                        onConversation = viewModel::openConversation,
                        onModel = viewModel::changeSelectedAgentModel,
                        onAutoWake = viewModel::changeSelectedAgentAutoWake,
                        onRetire = viewModel::retireSelectedAgent,
                        onOpenTask = viewModel::openTask,
                        onOpenRun = viewModel::openRun,
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
            }
        }
    }
}
