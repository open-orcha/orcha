package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
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
import io.openorcha.mobile.data.ImportTaskImpactDto
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
)

@Composable
internal fun WorkflowMenuSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    action: MenuAction,
    onClose: () -> Unit,
) {
    if (action == MenuAction.ReviewRound) return WorkflowReviewRoundSheet(controller, detail, snapshot, onClose)
    var objectiveId by remember { mutableStateOf<String?>(null) }
    objectiveId?.let { oid -> return WorkflowObjectiveSheet(controller, detail, oid) { objectiveId = null } }
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
    var pinned by remember { mutableStateOf<List<WorkflowTaskChoiceDto>>(emptyList()) }
    var reviews by remember { mutableStateOf<Map<String, WorkflowLogic.ImportReview>>(emptyMap()) }
    var releaseIds by remember { mutableStateOf<List<String>>(emptyList()) }
    var picked by remember { mutableStateOf<List<String>>(emptyList()) }
    var preview by remember { mutableStateOf<WorkflowPreviewDto?>(null) }
    var checkedPick by remember { mutableStateOf<List<String>?>(null) }
    // Move (W24): null = make the tasks standalone
    var destination by remember { mutableStateOf<String?>(null) }
    val destinations = s.loaded.filter { it.id != d.id && !it.hidden && it.status in setOf("active", "paused") }

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
                preview = null
                fresh() ?: checkRead({ repo.previewImport(d.id, WorkflowImportPreviewBody(picked, emptyMap())) }) {
                    preview = it
                    checkedPick = picked
                } ?: preview?.blockers?.takeIf { it.isNotEmpty() }?.joinToString("\n") { it.message }
            }
        }
        MenuAction.Move -> { { fresh().also { if (it == null) checkedPick = picked } } }
        MenuAction.Settings -> {
            {
                fresh() ?: (controller.state.value.detail ?: d).let { latest ->
                    WorkflowLogic.actionReason(latest, "patch", controller.hasHuman) ?: WorkflowLogic.modeChangeReason(latest, mode)
                }
            }
        }
        MenuAction.ReviewRound -> null
        else -> fresh
    }

    val loops = d.semanticsVersion == 2
    val settingsInvalid = WorkflowLogic.settingsInvalid(d, title, goal, reason, listOf(taskLimit, roundLimit), turns)
    val members = d.tasks.map { it.id }
    val importPreview = preview?.takeIf { checkedPick == picked }
    val canRelease = d.status == "active" && d.launchEnabled
    val invalidRelease = WorkflowLogic.invalidReleaseIds(releaseIds, importPreview, picked, canRelease)
    val importBlocked = WorkflowLogic.importBlocked(importPreview, picked, reviews, invalidRelease)
    val startIds = impact?.tasks?.filter { it.selected && it.canStart }?.map { it.taskId }.orEmpty()
    val inputsValid = when (action) {
        MenuAction.Start -> impact != null && startIds.isNotEmpty()
        MenuAction.Cancel -> impact != null && reason.isNotBlank()
        MenuAction.Finish -> completion?.canFinish == true
        MenuAction.Hide -> visibility != null && (if (d.hidden) visibility?.canRestore == true else visibility?.canHide == true)
        MenuAction.Settings -> settingsInvalid == null
        MenuAction.TransferOwner -> newOwner != null
        MenuAction.AddTasks -> newTitle.isNotBlank() && newDone.isNotBlank()
        MenuAction.Import -> picked.isNotEmpty() && importBlocked == null
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
        disabledHint = serverReason ?: settingsInvalid.takeIf { action == MenuAction.Settings }
            ?: importBlocked.takeIf { action == MenuAction.Import && picked.isNotEmpty() } ?: "Fill in the fields above, then check again.",
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
                    d, key, title, goal, mode, taskLimit.toIntOrNull(), roundLimit.toIntOrNull(), turns.toIntOrNull()?.takeIf { loops }, reason,
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
                MenuAction.Import -> importPreview?.let {
                    WorkflowWrites.import(d, key, picked, it.previewDigest, releaseIds, WorkflowLogic.importAcceptances(it, reviews))
                }
                MenuAction.Move -> WorkflowWrites.move(d, key, picked, destinations.firstOrNull { it.id == destination }, reason)
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
                listOf("serial" to "One task at a time", "parallel" to "Independent tasks together").forEach { (k, l) ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { mode = k }) {
                        RadioButton(mode == k, { mode = k })
                        Text(l, color = p.text)
                    }
                }
                NumberField("Task limit", taskLimit) { taskLimit = it }
                NumberField("Round limit", roundLimit) { roundLimit = it }
                if (loops) NumberField("Agent-turn allowance", turns) { turns = it }
                ReasonField(reason, required = true) { reason = it }
                Text("Objectives", style = ltype(LType.BodyEmph), color = p.text)
                if (d.objectives.isEmpty()) Text("No objectives were added to this workflow.", color = p.muted)
                d.objectives.forEach { o ->
                    Text(
                        "Edit objective: ${o.title}", color = p.accent,
                        modifier = Modifier.fillMaxWidth().clickable { objectiveId = o.id },
                    )
                }
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
                    query, { query = it.take(200); found = emptyList() },
                    Modifier.fillMaxWidth(), label = { Text("Find an existing task") }, singleLine = true,
                )
                Text(
                    "Search runs on the server and shows up to five matches. Orcha checks membership, workers and the whole connected dependency group before saving.",
                    style = ltype(LType.Meta), color = p.text2,
                )
                androidx.compose.runtime.LaunchedEffect(query, picked) {
                    if (query.isBlank() && picked.isEmpty()) { found = emptyList(); pinned = emptyList(); return@LaunchedEffect }
                    kotlinx.coroutines.delay(200)
                    runCatching { repo.searchTasks(query.trim(), picked) }.onSuccess {
                        found = it.results
                        pinned = it.selected
                    }
                }
                val known = (pinned + found).associateBy { it.id }
                val note = { t: WorkflowTaskChoiceDto -> WorkflowLogic.importChoiceNote(t.status, t.isRoot, t.workflowId, t.id, members) }
                if (picked.isNotEmpty()) {
                    Text("Selected tasks", style = ltype(LType.BodyEmph), color = p.text)
                    picked.forEachIndexed { i, id ->
                        val t = known[id] ?: WorkflowTaskChoiceDto(id = id, title = "Selected task ${i + 1}", status = "unknown")
                        PickRow(t.title, checked = true, note = note(t)) { picked = picked - id; releaseIds = releaseIds - id }
                    }
                }
                found.filter { it.id !in picked }.forEach { t ->
                    val blocked = WorkflowLogic.importChoiceReason(t.status, t.isRoot, t.workflowId, t.id, members) != null
                    PickRow(t.title, checked = false, note = note(t), enabled = !blocked) { picked = picked + t.id }
                }
                if (found.isEmpty() && query.isNotBlank()) Text("No tasks match this search.", color = p.muted)
                importPreview?.let { pv ->
                    ImportImpact(
                        pv, picked, canRelease, releaseIds,
                        onInclude = { picked = (picked + pv.requiredTaskIds).distinct() },
                        onRelease = { id, on -> releaseIds = if (on) releaseIds + id else releaseIds - id },
                    )
                    if (invalidRelease.isNotEmpty()) {
                        Text(
                            "Some saved start choices are no longer available. Remove unavailable start choices",
                            color = p.accent,
                            modifier = Modifier.fillMaxWidth().clickable { releaseIds = releaseIds - invalidRelease.toSet() },
                        )
                    }
                    pv.taskImpacts.filter { it.requiresAcceptance }.forEach { t ->
                        ImportReviewCard(t, reviews[t.id]) { reviews = reviews + (t.id to it) }
                    }
                }
            }
            MenuAction.Move -> {
                Text("Tasks to move", style = ltype(LType.BodyEmph), color = p.text)
                d.tasks.forEach { t ->
                    PickRow(t.title, t.id in picked) {
                        picked = if (t.id in picked) picked - t.id else picked + t.id
                    }
                }
                Text("Move to", style = ltype(LType.BodyEmph), color = p.text)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { destination = null; checkedPick = null }) {
                    RadioButton(destination == null, { destination = null; checkedPick = null })
                    Text("No workflow (standalone tasks)", color = p.text)
                }
                destinations.forEach { w ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { destination = w.id; checkedPick = null }) {
                        RadioButton(destination == w.id, { destination = w.id; checkedPick = null })
                        Text(w.title, color = p.text)
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
private fun PickRow(title: String, checked: Boolean, note: String? = null, enabled: Boolean = true, onToggle: () -> Unit) {
    val p = Orcha.palette
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onToggle)) {
        Checkbox(checked, { onToggle() }, enabled = enabled)
        Column {
            Text(title, color = if (enabled) p.text else p.muted)
            note?.let { Text(it, style = ltype(LType.Meta), color = p.text2) }
        }
    }
}

/* W11b impact: the whole connected group, per-task state, holds kept, and the optional
   "Start this task when it is ready" choice (release_task_ids). */
@Composable
private fun ImportImpact(
    preview: WorkflowPreviewDto,
    selected: List<String>,
    canRelease: Boolean,
    releaseIds: List<String>,
    onInclude: () -> Unit,
    onRelease: (String, Boolean) -> Unit,
) {
    val p = Orcha.palette
    val missing = preview.requiredTaskIds.filter { it !in selected }
    val groupCount = (preview.selectedTaskIds + preview.requiredTaskIds).toSet().size
    Text("Review the complete task group", style = ltype(LType.BodyEmph), color = p.text)
    Text(
        "${WorkflowLogic.plural(groupCount, "task")} in the connected group. Threads, results and assignments stay with their tasks. " +
            if (releaseIds.isNotEmpty()) "Selected tasks may start when ready after saving. Human holds, prerequisites and turn rules still apply."
            else "No work starts from this save; holds remain in place.",
        style = ltype(LType.Meta), color = p.text2,
    )
    preview.taskImpacts.forEach { t ->
        Text(t.title, color = p.text)
        Text(
            (if (!t.eligible) "Cannot be added" else if (t.preparationState == "draft") "Draft" else "Prepared") +
                if (t.startHold) " · Awaiting release" else "",
            style = ltype(LType.Meta), color = p.text2,
        )
        t.humanHoldReason?.let { Text("Hold retained: $it", style = ltype(LType.Meta), color = p.text2) }
        if (t.requiresAcceptance) {
            Text("This finished task needs explicit review of its exact saved result before import.", style = ltype(LType.Meta), color = p.text2)
        }
        if (canRelease || t.id in releaseIds) {
            val on = t.id in releaseIds
            val unavailable = !canRelease || !t.releasable || !t.eligible
            PickRow(
                "Start this task when it is ready: ${t.title}", checked = on,
                note = if (unavailable) "Starting this task from import is unavailable in this preview." else null,
                enabled = on || (!unavailable && t.id in selected),
            ) { onRelease(t.id, !on) }
        }
    }
    preview.blockers.forEach { Text("• ${it.message}", style = ltype(LType.Meta), color = p.text2) }
    if (missing.isNotEmpty()) {
        Text("Adding your selection also requires ${WorkflowLogic.plural(missing.size, "related task")}. Nothing has been added.", color = p.text)
        Text("Include the whole group and review again", color = p.accent, modifier = Modifier.fillMaxWidth().clickable(onClick = onInclude))
    }
}

/* W11b "Review finished result" card (web WorkflowImportReview): accepting pins the exact saved
   result; any change to it or its criteria clears the acceptance. */
@Composable
private fun ImportReviewCard(t: ImportTaskImpactDto, review: WorkflowLogic.ImportReview?, onChange: (WorkflowLogic.ImportReview) -> Unit) {
    val p = Orcha.palette
    val source = WorkflowLogic.importSource(t)
    val same = review?.source == source
    val unavailable = WorkflowLogic.importResultUnavailable(t)
    val narrative = review?.narrative.orEmpty()
    Text("Review finished result: ${t.title}", style = ltype(LType.BodyEmph), color = p.text)
    Text("This accepts the exact saved result while adding the task. It does not finish the workflow.", style = ltype(LType.Meta), color = p.text2)
    Text("Done when: ${t.definitionOfDone.ifBlank { "No completion criteria recorded" }}", style = ltype(LType.Meta), color = p.text2)
    t.description?.let { Text(it, style = ltype(LType.Meta), color = p.text2) }
    t.resultText?.let { Text(it, color = p.text) }
    t.completedAt?.let { Text("Completed: ${it.take(16).replace('T', ' ')}", style = ltype(LType.Meta), color = p.text2) }
    if (unavailable) Text("The exact saved result is unavailable. Refresh the preview before accepting this import.", color = p.text2)
    OutlinedTextField(
        narrative, { onChange(WorkflowLogic.ImportReview(source, it.take(4000), accepted = false)) },
        Modifier.fillMaxWidth(), enabled = !unavailable, minLines = 2,
        label = { Text("Why this result satisfies ${t.title}") },
    )
    PickRow(
        "I accept this saved result for ${t.title}.", checked = same && review?.accepted == true,
        enabled = !unavailable && narrative.isNotBlank(),
    ) { onChange(WorkflowLogic.ImportReview(source, narrative, accepted = !(same && review?.accepted == true))) }
    if (review != null && !same) Text("The result or its criteria changed. Read this preview and accept it again.", color = p.text2)
}

/* W22 objectives editor, opened from Workflow settings (web WorkflowObjectiveEditor): current vs
   proposed criteria; saving sends acceptance of the objective and the goal back for review. */
@Composable
private fun WorkflowObjectiveSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    objectiveId: String,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository ?: return
    val objective = d.objectives.firstOrNull { it.id == objectiveId } ?: return onClose()
    var title by remember { mutableStateOf(objective.title) }
    var criteria by remember { mutableStateOf(objective.criteria) }
    var reason by remember { mutableStateOf("") }
    val serverReason = WorkflowLogic.objectiveActionReason(d, objectiveId, "edit_objective", controller.hasHuman)
    val invalid = if (title.isBlank() || criteria.isBlank() || reason.isBlank()) {
        "Give the objective a title, completion criteria and reason for changing it."
    } else null

    WorkflowActionSheet(
        controller = controller,
        title = "Edit objective",
        description = "Changing this objective requires its acceptance and the goal acceptance to be reviewed again. Existing evidence stays in the history.",
        confirmLabel = "Save objective",
        onClose = onClose,
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: WorkflowLogic.objectiveActionReason(controller.state.value.detail ?: d, objectiveId, "edit_objective", controller.hasHuman)
        },
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = serverReason == null && invalid == null,
        disabledHint = serverReason ?: invalid,
        write = { key -> WorkflowWrites.editObjective(d, objectiveId, key, title, criteria, reason) },
    ) {
        OutlinedTextField(title, { title = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Objective title") })
        OutlinedTextField(criteria, { criteria = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Objective done when") }, minLines = 2)
        OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason for changing objective") }, minLines = 2)
        Text("Current: ${objective.criteria}", style = ltype(LType.Meta), color = p.text2)
        Text("Proposed: ${criteria.trim()}", style = ltype(LType.Meta), color = p.text)
    }
}
