package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.theme.Orcha

/** Owns the destructive close-task confirmation and reason entry. */
@Composable
internal fun TaskCloseDialog(
    task: TaskDto?,
    implications: List<String>?,
    reason: String,
    onReasonChange: (String) -> Unit,
    onDismiss: () -> Unit,
    onClose: () -> Unit,
) {
    if (task == null) return
    val p = Orcha.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Close ${task.title}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (implications != null) {
                    implications.forEach { Text("• $it") }
                } else {
                    Text("The task is force-closed and anything waiting on it unblocks. A reason is routed to the assignee.")
                }
                OrchaField(reason, onReasonChange, label = "Reason (recommended)", minLines = 2)
            }
        },
        confirmButton = {
            TextButton(onClick = onClose) {
                Text("Close task", color = p.danger, fontWeight = FontWeight.W700)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = p.accent) }
        },
        containerColor = p.raised,
    )
}
