package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.OkTonalButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.theme.Orcha

/* Flow 08 — the approval sheets, shared by WorkspaceScreen and TaskScreens. Plan
   text / DoD render in full (never truncated); Request-changes / Send-back expand
   a REQUIRED feedback field. */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanApprovalSheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onDecide: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("PLAN APPROVAL", style = MaterialTheme.typography.labelMedium, color = p.violet)
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            task.planMessage?.let { pm ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Avatar(pm.authorAlias ?: "?", human = false, size = AvatarSize.Sm)
                    Text("${pm.authorAlias ?: "agent"} proposes a plan", style = MaterialTheme.typography.bodyMedium, color = p.text2)
                }
            }
            SectionH("Proposed plan")
            OrchaCard(container = p.surface2) {
                LazyColumn(Modifier.height(240.dp)) {
                    item { Text(task.planMessage?.body ?: "No plan text found on the thread.", color = p.text, style = MaterialTheme.typography.bodyLarge) }
                }
            }
            if (rejecting) {
                OrchaField(reason, { reason = it }, label = "What should change?", minLines = 3, supporting = "${task.planMessage?.authorAlias ?: "The agent"} sees this on the next wake — required.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DangerTonalButton("Send back with changes", { onDecide(false, reason.trim()) }, Modifier.weight(1f), enabled = reason.isNotBlank() && !busy)
                    NeutralButton("Cancel", { rejecting = false }, enabled = !busy)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve plan", { onDecide(true, null) }, Modifier.weight(1f), enabled = !busy)
                    DangerTonalButton("Request changes…", { rejecting = true }, Modifier.weight(1f), enabled = !busy)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerifySheet(
    task: TaskDto,
    busy: Boolean,
    onDismiss: () -> Unit,
    onVerify: (Boolean, String?) -> Unit,
) {
    val p = Orcha.palette
    var rejecting by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("VERIFY TASK", style = MaterialTheme.typography.labelMedium, color = p.ok)
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            SectionH("Definition of done")
            OrchaCard(container = p.surface2, borderColor = p.okLine) {
                Text(task.definitionOfDone ?: "No definition of done was provided.", color = p.text, style = MaterialTheme.typography.bodyLarge)
            }
            (task.result ?: task.messageSummary?.last?.body)?.let {
                SectionH("Claimed result")
                OrchaCard(container = p.surface2) {
                    Text(it, color = p.text2, style = MaterialTheme.typography.bodyLarge, maxLines = 8, overflow = TextOverflow.Ellipsis)
                }
            }
            if (rejecting) {
                OrchaField(feedback, { feedback = it }, label = "What's missing?", minLines = 3, supporting = "Returns the task to in progress — required.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DangerTonalButton("Send back", { onVerify(false, feedback.trim()) }, Modifier.weight(1f), enabled = feedback.isNotBlank() && !busy)
                    NeutralButton("Cancel", { rejecting = false }, enabled = !busy)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve & complete", { onVerify(true, null) }, Modifier.weight(1f), enabled = !busy)
                    NeutralButton("Send back with feedback…", { rejecting = true }, Modifier.weight(1f), enabled = !busy)
                }
            }
        }
    }
}
