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
import io.openorcha.mobile.ui.screens.ManualConnectScreen
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
                    )

                    AppRoute.TaskDetail -> TaskDetailScreen(
                        state = state,
                        onBack = viewModel::showWorkspace,
                        onRefresh = viewModel::refreshSelectedTask,
                    )
                }
            }
        }
    }
}

