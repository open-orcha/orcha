package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.ui.WorkflowsController

/* WIP (next commit replaces this): W10 create workflow. */
@Composable
internal fun WorkflowCreateScreen(
    controller: WorkflowsController,
    agents: List<AgentDto>,
    humanId: String?,
    onClose: () -> Unit,
    onSaved: (WorkflowDetailDto) -> Unit,
) {
    BackHandler { onClose() }
}
