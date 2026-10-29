package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
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
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository ?: return
    var reason by remember { mutableStateOf("") }
    WorkflowActionSheet(
        controller = controller,
        title = "Resolve findings by owner decision",
        description = "Records that you closed the open review findings without another round. The findings stay in Review history beside your reason.",
        confirmLabel = "Resolve findings",
        onClose = onClose,
        // Fresh check (design L134): re-read the workflow, then the server's own resolve_loop gate.
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: WorkflowLogic.actionReason(controller.state.value.detail ?: d, "resolve_loop", controller.hasHuman)
        },
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = reason.isNotBlank(),
        disabledHint = "Write the reason first.",
        // The write carries the revision the check just read, never the one captured at open.
        write = { key -> WorkflowWrites.resolveLoop(controller.state.value.detail ?: d, taskId, key, reason) },
    ) {
        OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason (shown in Activity)") }, minLines = 2)
    }
}

/** W16/W17: membership still unknown (checking or failed) — nothing legacy is offered until it is known. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun WorkflowMembershipSheet(membership: io.openorcha.mobile.ui.TaskMembership, onRetry: () -> Unit, onDismiss: () -> Unit) {
    val p = io.openorcha.mobile.ui.theme.Orcha.palette
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg) {
        androidx.compose.foundation.layout.Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp),
        ) {
            WorkflowMembershipLine(membership, onRetry)
            io.openorcha.mobile.ui.components.LButton("Close", onDismiss, kind = io.openorcha.mobile.ui.components.LButtonKind.Ghost)
        }
    }
}

/** The loading / error line shown wherever membership decides which controls appear (W16). */
@Composable
internal fun WorkflowMembershipLine(membership: io.openorcha.mobile.ui.TaskMembership, onRetry: () -> Unit) {
    val p = io.openorcha.mobile.ui.theme.Orcha.palette
    when (membership) {
        is io.openorcha.mobile.ui.TaskMembership.Failed -> io.openorcha.mobile.ui.components.Banner(
            io.openorcha.mobile.ui.components.BannerKind.Warn,
            "Couldn't check whether this task is in a workflow. ${membership.message}",
            action = "Try again", onAction = onRetry,
        )
        io.openorcha.mobile.ui.TaskMembership.Checking -> Text(
            "Checking whether this task is in a workflow…",
            style = io.openorcha.mobile.ui.components.ltype(io.openorcha.mobile.ui.components.LType.Meta), color = p.muted,
        )
        else -> Unit
    }
}
