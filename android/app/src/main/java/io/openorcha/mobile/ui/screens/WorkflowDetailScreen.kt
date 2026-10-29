package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.ui.WorkflowsController

/* WIP (next commit replaces this): W03 workflow detail. */
@Composable
internal fun WorkflowDetailScreen(controller: WorkflowsController, snapshot: ContainerSnapshot, onOpenTask: (String) -> Unit) {
    BackHandler { controller.closeWorkflow() }
}
