package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.TaskApprovalRecordDto
import io.openorcha.mobile.data.WorkflowApiException
import io.openorcha.mobile.data.WorkflowTaskDto
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/*
 * W16 "Task authority" on the task page: the Autonomy switch with its confirmation card
 * (`PUT /api/tasks/{tid}/autonomy`) and "Read approval history" (`GET /api/tasks/{tid}/approvals`).
 * The current value comes from the workflow read (`WorkflowTask.autonomy`); task reads in
 * /openapi.json carry no autonomy field, so standalone tasks get the history only.
 */

@Composable
internal fun TaskAuthoritySection(
    controller: WorkflowsController,
    taskId: String,
    /** The task's row in its workflow, or null for standalone tasks (membership checked first). */
    workflowTask: WorkflowTaskDto?,
    isRoot: Boolean,
    finished: Boolean,
) {
    val p = Orcha.palette
    val scope = rememberCoroutineScope()
    var proposed by remember(taskId) { mutableStateOf<Boolean?>(null) }
    var saving by remember(taskId) { mutableStateOf(false) }
    var error by remember(taskId) { mutableStateOf<String?>(null) }
    var uncertain by remember(taskId) { mutableStateOf(false) }
    var history by remember(taskId) { mutableStateOf<List<TaskApprovalRecordDto>?>(null) }
    var historyLoading by remember(taskId) { mutableStateOf(false) }
    var historyError by remember(taskId) { mutableStateOf<String?>(null) }
    val editable = workflowTask != null && !isRoot && !finished && controller.hasHuman

    LSection("Task authority") {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            workflowTask?.let { wt ->
                val on = wt.autonomy == "on"
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("Autonomy ${if (on) "ON" else "OFF"}", style = ltype(LType.BodyEmph), color = p.text)
                        Text(autonomyMeaning(on), style = ltype(LType.Meta), color = p.text2)
                    }
                    Switch(
                        checked = proposed ?: on,
                        enabled = editable && !saving && proposed == null,
                        onCheckedChange = { error = null; uncertain = false; proposed = it },
                    )
                }
                if (!editable) {
                    Text(
                        when {
                            isRoot -> "The project's root task keeps its authority."
                            finished -> "Finished tasks keep the authority they ran with."
                            else -> "Only the project owner changes a task's authority."
                        },
                        style = ltype(LType.Meta), color = p.muted,
                    )
                }
                proposed?.let { next ->
                    LCard {
                        Text("Turn autonomy ${if (next) "ON" else "OFF"}?", style = ltype(LType.BodyEmph), color = p.text)
                        Text(
                            "${autonomyMeaning(next)} This applies to future actions; approvals already given stay as they are.",
                            style = ltype(LType.Meta), color = p.text2,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            LButton("Keep", onClick = { proposed = null }, kind = LButtonKind.Ghost, enabled = !saving)
                            LButton(
                                if (saving) "Saving…" else "Save",
                                kind = LButtonKind.Primary,
                                enabled = !saving,
                                onClick = {
                                    saving = true
                                    scope.launch {
                                        controller.setTaskAutonomy(taskId, next)
                                            .onSuccess { proposed = null }
                                            .onFailure { e ->
                                                uncertain = e is WorkflowApiException && e.uncertain
                                                error = e.message ?: "Orcha refused this change."
                                                if (uncertain) proposed = null
                                            }
                                        saving = false
                                    }
                                },
                            )
                        }
                    }
                }
                error?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
                if (uncertain) {
                    LButton("Check current setting", onClick = { error = null; uncertain = false; controller.refreshList() })
                }
            }
            if (history == null) {
                LButton(
                    if (historyLoading) "Reading…" else "Read approval history",
                    enabled = !historyLoading,
                    onClick = {
                        historyLoading = true; historyError = null
                        scope.launch {
                            controller.taskApprovals(taskId)
                                .onSuccess { history = it.approvals }
                                .onFailure { historyError = it.message ?: "Could not read the approval history." }
                            historyLoading = false
                        }
                    },
                )
            }
            historyError?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
            history?.let { rows ->
                if (rows.isEmpty()) Text("No plan or finished-work approvals yet.", style = ltype(LType.Meta), color = p.muted)
                rows.forEach { ApprovalRow(it) }
            }
        }
    }
}

private fun autonomyMeaning(on: Boolean) =
    if (on) "The agent acts on its plan and finished work without waiting for a person."
    else "The agent waits for a person to approve its plan and its finished work."

@Composable
private fun ApprovalRow(a: TaskApprovalRecordDto) {
    val p = Orcha.palette
    var open by remember(a.id) { mutableStateOf(false) }
    val phase = when (a.phase) {
        "plan" -> "Plan approved"
        "completion" -> "Finished work approved"
        else -> "Approved (${a.phase})"
    }
    Column(Modifier.fillMaxWidth().clickable { open = !open }) {
        Text("$phase · ${a.actorAlias.ifBlank { a.actorKind }} · ${shortTime(a.approvedAt)}", style = ltype(LType.Body), color = p.text)
        Text(
            "Autonomy ${a.autonomyAtApproval.uppercase()} · ${a.permissionSource.replace('_', ' ')} · work revision ${a.workRevision}",
            style = ltype(LType.Meta), color = p.text2,
        )
        if (open) {
            Text("Requirements ${a.requirementsSha256.take(12)} · submission ${a.submissionSha256.take(12)}", style = ltype(LType.Meta), color = p.muted)
        }
    }
}
