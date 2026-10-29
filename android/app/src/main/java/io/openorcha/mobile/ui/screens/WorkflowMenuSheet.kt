package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.VisibilityCheckDto
import io.openorcha.mobile.data.WorkflowCompletionDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowImpactDto
import io.openorcha.mobile.data.WorkflowImportPreviewBody
import io.openorcha.mobile.data.WorkflowNewTaskBody
import io.openorcha.mobile.data.WorkflowPreviewDto
import io.openorcha.mobile.data.WorkflowTaskChoiceDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.domain.WorkflowLogic.MenuAction
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W07 workflow rows of the action table plus W11 (add new tasks), W11b (add existing tasks),
   W13 (finish checklist) and W22–W26 (settings, transfer, hide/restore, move). Copy is the
   web's (WorkflowActions.tsx). Every check is a fresh server read; confirm stays disabled
   until the check matches the current inputs. */

private val MENU_DESCRIPTIONS = mapOf(
    MenuAction.Start to "Review start releases the prepared tasks below. Dependencies, holds and task autonomy still apply; nothing else starts.",
    MenuAction.Pause to "No new tasks start while paused. Running work continues and is not stopped.",
    MenuAction.Resume to "New starts are allowed again. Holds, dependencies and owner decisions stay in place.",
    MenuAction.Cancel to "Cancelling stops new starts and asks running workers to stop. Accepted results are kept. This cannot be undone.",
    MenuAction.Finish to "Finishing closes the workflow once every required task and the goal are accepted.",
    MenuAction.Hide to "Hidden workflows leave the main list. Nothing is deleted; you can restore it from Hidden workflows.",
    MenuAction.Settings to "Changes apply to future starts. Running work is not changed.",
    MenuAction.TransferOwner to "The new owner makes the owner decisions from now on. You keep read access.",
    MenuAction.AddTasks to "New tasks are added as drafts. Adding a task does not start it; prepare it, then Review start.",
    MenuAction.Import to "Existing tasks join this workflow with their history. Completed results need acceptance before they count.",
    MenuAction.Move to "Moved tasks leave this workflow. Tasks moved nowhere become standalone tasks; their history stays.",
    MenuAction.ReviewRound to "Record the outcome of a review round from the review task's sheet: open the task, then Review result.",
)

@Composable
internal fun WorkflowMenuSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    action: MenuAction,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository ?: return
    val hiding = action == MenuAction.Hide && !d.hidden
    val restoring = action == MenuAction.Hide && d.hidden

    var reason by remember { mutableStateOf("") }
    var impact by remember { mutableStateOf<WorkflowImpactDto?>(null) }
    var completion by remember { mutableStateOf<WorkflowCompletionDto?>(null) }
    var visibility by remember { mutableStateOf<VisibilityCheckDto?>(null) }
    // Settings (W22)
    var title by remember { mutableStateOf(d.title) }
    var goal by remember { mutableStateOf(d.goal) }
    var mode by remember { mutableStateOf(d.executionMode) }
    var taskLimit by remember { mutableStateOf(d.taskLimit.toString()) }
    var roundLimit by remember { mutableStateOf(d.roundLimit.toString()) }
    var turns by remember { mutableStateOf(d.turnAllowance.toString()) }
    // Transfer (W23)
    val humans = snapshot.agents.filter { it.kind == "human" && it.id != d.ownerHumanId }
    var newOwner by remember { mutableStateOf<String?>(null) }
    // Add new task (W11)
    var newTitle by remember { mutableStateOf("") }
    var newDone by remember { mutableStateOf("") }
    var newAssignee by remember { mutableStateOf<String?>(null) }
    // Import (W11b) / Move (W26)
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<WorkflowTaskChoiceDto>>(emptyList()) }
    var picked by remember { mutableStateOf<List<String>>(emptyList()) }
    var preview by remember { mutableStateOf<WorkflowPreviewDto?>(null) }
    var checkedPick by remember { mutableStateOf<List<String>?>(null) }

    val serverReason = WorkflowLogic.menuReason(d, action, controller.hasHuman)
    val agents = snapshot.agents.filter { it.kind != "human" }
    val label = when {
        restoring -> "Restore workflow"
        else -> action.label.removeSuffix("…")
    }

    val fresh: suspend () -> String? = {
        checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
            ?: WorkflowLogic.menuReason(controller.state.value.detail ?: d, action, controller.hasHuman)
    }
    val check: (suspend () -> String?)? = when (action) {
        MenuAction.Start -> { { checkRead({ repo.impact(d.id, "start-check") }) { impact = it.impact } } }
        MenuAction.Cancel -> { { checkRead({ repo.impact(d.id, "cancellation-check") }) { impact = it.impact } } }
        MenuAction.Finish -> {
            {
                checkRead({ repo.completionCheck(d.id) }) { completion = it }
                    ?: completion?.takeIf { !it.canFinish }?.let { c -> c.blockers.joinToString("\n") { it.message }.ifBlank { "This workflow cannot finish yet." } }
            }
        }
        MenuAction.Hide -> {
            {
                checkRead({ repo.visibilityCheck(d.id) }) { visibility = it }
                    ?: visibility?.let { v ->
                        val ok = if (d.hidden) v.canRestore else v.canHide
                        if (ok) null else v.blockers.joinToString("\n") { it.message }.ifBlank { "Not available right now." }
                    }
            }
        }
        MenuAction.Import -> {
            {
                checkRead({ repo.previewImport(d.id, WorkflowImportPreviewBody(picked)) }) {
                    preview = it
                    checkedPick = picked
                } ?: preview?.blockers?.takeIf { it.isNotEmpty() }?.joinToString("\n") { it.message }
            }
        }
        MenuAction.Move -> { { fresh().also { if (it == null) checkedPick = picked } } }
        MenuAction.ReviewRound -> null
        else -> fresh
    }

    val startIds = impact?.tasks?.filter { it.selected && it.canStart }?.map { it.taskId }.orEmpty()
    val inputsValid = when (action) {
        MenuAction.Start -> impact != null && startIds.isNotEmpty()
        MenuAction.Cancel -> impact != null && reason.isNotBlank()
        MenuAction.Finish -> completion?.canFinish == true
        MenuAction.Hide -> visibility != null && (if (d.hidden) visibility?.canRestore == true else visibility?.canHide == true)
        MenuAction.Settings -> title.isNotBlank() && goal.isNotBlank() &&
            listOf(taskLimit, roundLimit, turns).all { it.toIntOrNull()?.let { n -> n > 0 } == true }
        MenuAction.TransferOwner -> newOwner != null
        MenuAction.AddTasks -> newTitle.isNotBlank() && newDone.isNotBlank()
        MenuAction.Import -> picked.isNotEmpty() && checkedPick == picked && preview?.blockers.isNullOrEmpty()
        MenuAction.Move -> picked.isNotEmpty() && checkedPick == picked && reason.isNotBlank()
        MenuAction.ReviewRound -> false
        else -> true
    }

    WorkflowActionSheet(
        controller = controller,
        title = label,
        description = (if (restoring) "Restore puts this workflow back in the main list." else MENU_DESCRIPTIONS[action].orEmpty()),
        confirmLabel = label,
        onClose = onClose,
        danger = action.danger,
        check = check,
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = serverReason == null && inputsValid,
        disabledHint = serverReason ?: "Fill in the fields above, then check again.",
        successNotice = when {
            hiding -> "Workflow hidden."
            restoring -> "Workflow restored."
            else -> null
        },
        onSaved = { if (hiding) controller.afterHidden(it) },
        write = { key ->
            when (action) {
                MenuAction.Start -> WorkflowWrites.start(
                    d, key, startIds, impact?.taskRevisions.orEmpty().filterKeys { it in startIds }, reason.takeIf { it.isNotBlank() },
                )
                MenuAction.Pause, MenuAction.Resume, MenuAction.Cancel, MenuAction.Finish ->
                    WorkflowWrites.workflowMutation(d, action.key, key, reason)
                MenuAction.Hide -> WorkflowWrites.workflowMutation(d, if (d.hidden) "restore" else "hide", key, reason)
                MenuAction.Settings -> WorkflowWrites.patch(
                    d, key, title, goal, mode, taskLimit.toIntOrNull(), roundLimit.toIntOrNull(), turns.toIntOrNull(), reason,
                )
                MenuAction.TransferOwner -> newOwner?.let { WorkflowWrites.transferOwner(d, key, it, reason) }
                MenuAction.AddTasks -> WorkflowWrites.addTasks(
                    d, key,
                    listOf(
                        WorkflowNewTaskBody(
                            clientKey = "t1", title = newTitle.trim(), definitionOfDone = newDone.trim(), assigneeId = newAssignee,
                        ),
                    ),
                )
                MenuAction.Import -> preview?.let { WorkflowWrites.import(d, key, picked, it.previewDigest, emptyList()) }
                MenuAction.Move -> WorkflowWrites.move(d, key, picked, null, reason)
                MenuAction.ReviewRound -> null
            }
        },
    ) {
        when (action) {
            MenuAction.Start, MenuAction.Cancel -> {
                if (action == MenuAction.Cancel) ReasonField(reason, required = true) { reason = it }
                impact?.let { ImpactCard(it) }
            }
            MenuAction.Finish -> completion?.let { c ->
                if (c.canFinish) Text("Every required task and the goal are accepted.", color = p.text)
                else c.blockers.forEach { Text("• ${it.message}", style = ltype(LType.Meta), color = p.text2) }
            }
            MenuAction.Hide -> visibility?.let { v ->
                Text("${v.taskCount} tasks · ${v.liveTurns} running", style = ltype(LType.Meta), color = p.text2)
                v.blockers.forEach { Text("• ${it.message}", style = ltype(LType.Meta), color = p.text2) }
            }
            MenuAction.Settings -> {
                OutlinedTextField(title, { title = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Title") })
                OutlinedTextField(goal, { goal = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Goal") }, minLines = 2)
                Text("Run tasks", style = ltype(LType.BodyEmph), color = p.text)
                listOf("serial" to "One at a time", "parallel" to "In parallel").forEach { (k, l) ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { mode = k }) {
                        RadioButton(mode == k, { mode = k })
                        Text(l, color = p.text)
                    }
                }
                NumberField("Task limit", taskLimit) { taskLimit = it }
                NumberField("Round limit", roundLimit) { roundLimit = it }
                NumberField("Turn allowance", turns) { turns = it }
                ReasonField(reason, required = false) { reason = it }
            }
            MenuAction.TransferOwner -> {
                if (humans.isEmpty()) Text("No other human in this project can own it.", color = p.muted)
                humans.forEach { h ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { newOwner = h.id }) {
                        RadioButton(newOwner == h.id, { newOwner = h.id })
                        Text(h.alias, color = p.text)
                    }
                }
                ReasonField(reason, required = false) { reason = it }
            }
            MenuAction.AddTasks -> {
                OutlinedTextField(newTitle, { newTitle = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Task title") })
                OutlinedTextField(newDone, { newDone = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Done when") }, minLines = 2)
                AgentPicker("Assignee (optional)", agents, newAssignee, allowKeep = true) { newAssignee = it }
            }
            MenuAction.Import -> {
                OutlinedTextField(
                    query,
                    {
                        query = it.take(200)
                    },
                    Modifier.fillMaxWidth(), label = { Text("Search tasks") }, singleLine = true,
                )
                androidx.compose.runtime.LaunchedEffect(query) {
                    kotlinx.coroutines.delay(300)
                    found = runCatching { repo.searchTasks(query, picked).results }.getOrDefault(emptyList())
                        .filter { it.workflowId == null }
                }
                found.forEach { t ->
                    PickRow(t.title, t.id in picked) {
                        picked = if (t.id in picked) picked - t.id else picked + t.id
                    }
                }
                preview?.takeIf { checkedPick == picked }?.taskImpacts?.forEach {
                    Text(
                        "• ${it.title}: " + if (it.requiresAcceptance) "needs acceptance before it counts" else if (it.eligible) "can join" else "cannot join",
                        style = ltype(LType.Meta), color = p.text2,
                    )
                }
            }
            MenuAction.Move -> {
                Text("Tasks to remove from this workflow", style = ltype(LType.BodyEmph), color = p.text)
                d.tasks.forEach { t ->
                    PickRow(t.title, t.id in picked) {
                        picked = if (t.id in picked) picked - t.id else picked + t.id
                    }
                }
                ReasonField(reason, required = true) { reason = it }
            }
            MenuAction.ReviewRound -> Unit
            else -> ReasonField(reason, required = false) { reason = it }
        }
    }
}

@Composable
private fun ReasonField(value: String, required: Boolean, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, { onChange(it.take(4000)) }, Modifier.fillMaxWidth(),
        label = { Text(if (required) "Reason" else "Reason (optional)") }, minLines = 2,
    )
}

@Composable
private fun NumberField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, { onChange(it.filter(Char::isDigit).take(4)) }, Modifier.fillMaxWidth(),
        label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun PickRow(title: String, checked: Boolean, onToggle: () -> Unit) {
    val p = Orcha.palette
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle)) {
        Checkbox(checked, { onToggle() })
        Text(title, color = p.text)
    }
}
