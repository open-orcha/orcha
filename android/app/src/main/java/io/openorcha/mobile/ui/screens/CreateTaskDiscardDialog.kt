package io.openorcha.mobile.ui.screens

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import io.openorcha.mobile.ui.theme.Orcha

/** Owns confirmation for abandoning a dirty create-task draft. */
@Composable
internal fun CreateTaskDiscardDialog(
    visible: Boolean,
    onKeep: () -> Unit,
    onDiscard: () -> Unit,
) {
    if (!visible) return
    val p = Orcha.palette
    AlertDialog(
        onDismissRequest = onKeep,
        title = { Text("Discard draft?") },
        text = { Text("Your task draft will be lost.") },
        confirmButton = {
            TextButton(onClick = onDiscard) {
                Text("Discard draft", color = p.danger, fontWeight = FontWeight.W700)
            }
        },
        dismissButton = {
            TextButton(onClick = onKeep) { Text("Keep editing", color = p.accent) }
        },
        containerColor = p.raised,
    )
}
