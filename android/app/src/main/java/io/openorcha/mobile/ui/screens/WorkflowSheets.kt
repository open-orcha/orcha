package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrite
import io.openorcha.mobile.data.WorkflowsRepository
import io.openorcha.mobile.ui.WorkflowOperation
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/* Sheet routing for the workflow detail (design #373 §2 stack: detail → task sheet → action
   sheet) and the one action-sheet pattern every W07/W08 row uses: inputs · Check · impact ·
   confirm, one idempotency key per opened sheet, undismissable while sending or uncertain. */

@Composable
internal fun WorkflowSheetHost(
    sheet: WorkflowSheet?,
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    onOpenTask: (String) -> Unit,
    onSheet: (WorkflowSheet?) -> Unit,
) {
    val close = { onSheet(null) }
    when (sheet) {
        null -> Unit
        is WorkflowSheet.Task -> WorkflowTaskSheet(
            controller, detail, snapshot, sheet.taskId,
            onClose = close,
            onAction = { onSheet(WorkflowSheet.TaskAction(sheet.taskId, it)) },
            onReviewResult = { onSheet(WorkflowSheet.ResultReview(sheet.taskId)) },
            onDecide = { onSheet(WorkflowSheet.Decision(sheet.taskId)) },
            onOpenTask = onOpenTask,
            onOpenTaskSheet = { onSheet(WorkflowSheet.Task(it)) },
        )
        is WorkflowSheet.TaskAction -> WorkflowTaskActionSheet(
            controller, detail, snapshot, sheet.taskId, sheet.action,
            onClose = { onSheet(WorkflowSheet.Task(sheet.taskId)) },
        )
        is WorkflowSheet.Menu -> WorkflowMenuSheet(controller, detail, snapshot, sheet.action, onClose = close)
        is WorkflowSheet.ResultReview -> WorkflowResultReviewSheet(controller, detail, snapshot, sheet.taskId, onClose = close)
        is WorkflowSheet.Decision -> WorkflowDecisionSheet(controller, detail, snapshot, sheet.taskId, onClose = close)
        is WorkflowSheet.ResolveFindings -> WorkflowResolveSheet(controller, detail, sheet.taskId, onClose = close)
        is WorkflowSheet.Plan -> WorkflowPlanSheet(controller, snapshot, sheet.taskId, onOpenTask = onOpenTask, onClose = close)
    }
}

/**
 * The shared action sheet (W07/W08). [check] runs the action's check read and returns an
 * error message or null; [confirmEnabled] is the caller's "check matches current inputs";
 * [write] builds the write with this sheet's idempotency key. Danger confirms ask once more
 * in an AlertDialog (Android, design §5).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkflowActionSheet(
    controller: WorkflowsController,
    title: String,
    description: String,
    confirmLabel: String,
    onClose: () -> Unit,
    danger: Boolean = false,
    checkLabel: String? = "Check",
    checkedNote: String? = null,
    check: (suspend () -> String?)? = null,
    confirmEnabled: Boolean = true,
    disabledHint: String? = null,
    successNotice: String? = null,
    write: (key: String) -> WorkflowWrite?,
    onSaved: (WorkflowDetailDto) -> Unit = {},
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val key = remember { WorkflowsRepository.newIdempotencyKey() }
    val scope = rememberCoroutineScope()
    val unresolved = s.operation is WorkflowOperation.Sending || s.operation is WorkflowOperation.Uncertain
    var checking by remember { mutableStateOf(false) }
    var checkError by remember { mutableStateOf<String?>(null) }
    var checked by remember { mutableStateOf(check == null) }
    var confirmDanger by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || !unresolved },
    )
    BackHandler(enabled = unresolved) { controller.notify("Still saving — keep this sheet open.") }

    fun runCheck() {
        val c = check ?: return
        checking = true
        checkError = null
        scope.launch {
            val error = c()
            checking = false
            checkError = error
            checked = error == null
        }
    }

    fun confirm() {
        val w = write(key) ?: return
        controller.send(title, w, successNotice ?: "$title saved") { d ->
            onSaved(d)
            onClose()
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!unresolved) onClose() },
        sheetState = sheetState,
        containerColor = p.bg,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = ltype(LType.Headline), color = p.text)
            if (description.isNotBlank()) Text(description, style = ltype(LType.Body), color = p.text2)
            content()
            if (check != null && checkLabel != null) {
                LButton(
                    if (checking) "Checking…" else checkLabel, { runCheck() },
                    kind = LButtonKind.Secondary, enabled = !checking && !unresolved,
                )
                checkError?.let { Banner(BannerKind.Danger, it) }
                if (checked && checkError == null) checkedNote?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
            }
            s.operation?.let { OperationNotice(it, controller) }
            val canConfirm = checked && confirmEnabled && !unresolved && !s.detailStale
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LButton("Close", { if (!unresolved) onClose() }, kind = LButtonKind.Ghost, enabled = !unresolved)
                LButton(
                    confirmLabel,
                    { if (danger) confirmDanger = true else confirm() },
                    Modifier.weight(1f),
                    kind = if (danger) LButtonKind.Danger else LButtonKind.Primary,
                    enabled = canConfirm,
                )
            }
            val hint = when {
                s.detailStale -> "Refresh the workflow before making changes."
                !checked && check != null -> "Run the check first."
                else -> disabledHint.takeIf { !confirmEnabled }
            }
            hint?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
        }
    }
    if (confirmDanger) {
        AlertDialog(
            onDismissRequest = { confirmDanger = false },
            title = { Text(title) },
            text = { Text("This cannot be undone from the phone. $description") },
            confirmButton = { TextButton(onClick = { confirmDanger = false; confirm() }) { Text(confirmLabel, color = p.danger) } },
            dismissButton = { TextButton(onClick = { confirmDanger = false }) { Text("Keep") } },
        )
    }
}

/** The check read, turned into "error message or null" for [WorkflowActionSheet]. */
internal suspend fun <T> checkRead(read: suspend () -> T, onResult: (T) -> Unit): String? = try {
    onResult(read())
    null
} catch (e: io.openorcha.mobile.data.WorkflowApiException) {
    e.message ?: "The check failed. Refresh and try again."
}
