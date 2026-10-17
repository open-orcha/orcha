package io.openorcha.mobile.ui.screens

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
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
        title = { Text("Discard draft?", style = ltype(LType.Headline), color = p.text) },
        text = { Text("Your task draft will be lost.", style = ltype(LType.Body), color = p.text2) },
        confirmButton = { LButton("Discard draft", onDiscard, kind = LButtonKind.Danger) },
        dismissButton = { LButton("Keep editing", onKeep, kind = LButtonKind.Ghost) },
        containerColor = p.surface,
    )
}
