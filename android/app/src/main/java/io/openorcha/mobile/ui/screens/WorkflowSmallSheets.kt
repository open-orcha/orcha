package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.ui.WorkflowsController

/* Small workflow sheets: W18 plan approval (the existing flows/08 sheet) and W25's
   "Resolve findings by owner decision". */

@Composable
internal fun WorkflowPlanSheet(
    controller: WorkflowsController,
    snapshot: ContainerSnapshot,
    taskId: String,
    onOpenTask: (String) -> Unit,
    onClose: () -> Unit,
) {
    val task = snapshot.tasks.firstOrNull { it.id == taskId }
    if (task == null) {
        // Outside the loaded snapshot window: the task page carries the same plan sheet.
        LaunchedEffect(taskId) { onClose(); onOpenTask(taskId) }
        return
    }
    PlanApprovalSheet(
        task = task,
        busy = false,
        onDismiss = onClose,
        onDecide = { approve, reason -> controller.decidePlan(taskId, approve, reason, onClose) },
    )
}

@Composable
internal fun WorkflowResolveSheet(controller: WorkflowsController, detail: WorkflowDetailDto, taskId: String, onClose: () -> Unit) {
    var reason by remember { mutableStateOf("") }
    WorkflowActionSheet(
        controller = controller,
        title = "Resolve findings by owner decision",
        description = "Records that you closed the open review findings without another round. The findings stay in Review history beside your reason.",
        confirmLabel = "Resolve findings",
        onClose = onClose,
        confirmEnabled = reason.isNotBlank(),
        disabledHint = "Write the reason first.",
        write = { key -> WorkflowWrites.resolveLoop(detail, taskId, key, reason) },
    ) {
        OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason (shown in Activity)") }, minLines = 2)
    }
}
