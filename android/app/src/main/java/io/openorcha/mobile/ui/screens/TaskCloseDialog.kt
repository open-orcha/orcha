package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
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
        title = { Text("Close ${task.title}?", style = ltype(LType.Headline), color = p.text, maxLines = 3, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
                if (implications != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        implications.forEach {
                            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                                Text("·", style = ltype(LType.Body), color = p.faint)
                                Text(it, style = ltype(LType.Body), color = p.text2)
                            }
                        }
                    }
                } else {
                    Text(
                        "Closes it as cancelled and unblocks anything waiting on it. A running worker isn't stopped. A reason is sent to the assignee.",
                        style = ltype(LType.Body), color = p.text2,
                    )
                }
                OrchaField(reason, onReasonChange, label = "Reason (recommended)", minLines = 2)
            }
        },
        confirmButton = { LButton("Close task", onClose, kind = LButtonKind.Danger) },
        dismissButton = { LButton("Keep task", onDismiss, kind = LButtonKind.Ghost) },
        containerColor = p.surface,
    )
}
