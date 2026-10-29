package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.domain.WorkflowLogic.TaskAction
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W07/W08 task rows of the action table: Prepare, Put on hold, Release holds, Retry / Let
   worker start, Stop / Send stop again, Release lost worker, Withdraw from scope, Edit
   prerequisites (W12), Submit / Withdraw outside result, Replace missing evidence. Copy is
   the web's (WorkflowTaskActions.tsx). "fresh detail" checks re-read the workflow so the
   confirm sends the revisions it was checked against. */

private val DESCRIPTIONS = mapOf(
    TaskAction.Prepare to "Set what done means and who does it. Preparing does not start the task; Review start releases prepared tasks.",
    TaskAction.Hold to "The task will not start while this hold remains. Existing prerequisites and start holds stay in place.",
    TaskAction.Release to "Only the selected holds are removed. All other holds, owner decisions and prerequisites remain; releasing a hold does not promise the task will run.",
    TaskAction.Dependencies to "Saving may make this task eligible. It does not accept or withdraw an old prerequisite. Goal acceptance will need review again.",
    TaskAction.Stop to "This sends a stop request. The task remains Stopping until Orcha confirms shutdown; requesting a stop is not confirmation that the worker is gone.",
    TaskAction.Retry to "This begins a new attempt through the scheduler. Dependencies, holds and task autonomy still apply.",
    TaskAction.ReissueStop to "Send the existing stop instruction again. This does not restart the waiting period or confirm shutdown.",
    TaskAction.SubmitOutsideResult to "Saving a real outside result does not accept it. It waits for review under the same holds, dependencies and turn rules. No worker starts from this submission.",
    TaskAction.AddEvidence to "This saves a new evidence set for the missing current result. Earlier files and acceptance records remain unchanged. Review the newly saved evidence separately before accepting.",
    TaskAction.WithdrawEvidence to "This withdraws the proposed outside result, not the required task. The task waits for an explicit owner decision; it will not restart automatically. Other holds stay in place.",
    TaskAction.Withdraw to "The task leaves required scope without being accepted. This cannot be undone; remaining dependents must be resolved first. Goal acceptance will need review again.",
    TaskAction.ReleaseLostWorker to "This worker may still be running outside Orcha. Orcha will refuse anything it sends from now on. Releasing it does not accept the task or confirm shutdown.",
)

@Composable
internal fun WorkflowTaskActionSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    taskId: String,
    action: TaskAction,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val task = d.tasks.firstOrNull { it.id == taskId } ?: return onClose()
    val repo = controller.repository ?: return
    val agents = snapshot.agents.filter { it.kind != "human" || it.id == controller.actorId }

    var reason by remember { mutableStateOf("") }
    var criteria by remember { mutableStateOf(task.definitionOfDone) }
    var assignee by remember { mutableStateOf(task.assigneeIds.firstOrNull()) }
    var riskAccepted by remember { mutableStateOf(false) }
    val allowedHolds = task.availableActions.firstOrNull { it.action == "release" && it.enabled }?.holds.orEmpty()
    var holds by remember { mutableStateOf(allowedHolds.toSet()) }
    var checkedHolds by remember { mutableStateOf<Set<String>?>(null) }
    var impact by remember { mutableStateOf<io.openorcha.mobile.data.WorkflowImpactDto?>(null) }
    var resultText by remember { mutableStateOf("") }
    var evidenceText by remember { mutableStateOf("") }
    var producedBy by remember { mutableStateOf("") }
    var deps by remember { mutableStateOf(task.dependsOn) }
    var checkedDeps by remember { mutableStateOf<List<String>?>(null) }

    val serverReason = WorkflowLogic.taskActionReason(d, task, action.key, controller.hasHuman)
    val danger = action.group == WorkflowLogic.DANGER
    val label = WorkflowLogic.taskActionLabel(task, action)

    val freshCheck: suspend () -> String? = {
        checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
            ?: WorkflowLogic.taskActionReason(controller.state.value.detail ?: d, (controller.state.value.detail ?: d).tasks.firstOrNull { it.id == taskId } ?: task, action.key, controller.hasHuman)
    }
    val check: suspend () -> String? = when (action) {
        TaskAction.Release -> {
            {
                checkRead({ repo.impact(d.id, "release-check", listOf(task.id), holds.toList()) }) {
                    impact = it.impact
                    checkedHolds = holds
                }
            }
        }
        TaskAction.Dependencies -> {
            { freshCheck().also { if (it == null) checkedDeps = deps } }
        }
        else -> freshCheck
    }

    val inputsValid = when (action) {
        TaskAction.Prepare -> criteria.isNotBlank() && assignee != null
        TaskAction.ReleaseLostWorker -> reason.isNotBlank() && riskAccepted && task.displayState.releaseAvailable
        TaskAction.Release -> holds.isNotEmpty() && holds.all { it in allowedHolds } && checkedHolds == holds &&
            impact?.tasks?.none { it.selected && (it.resultingStatus == "refused" || it.refusal != null) } == true
        TaskAction.WithdrawEvidence -> task.outsideResultId != null && reason.isNotBlank()
        TaskAction.Dependencies -> checkedDeps == deps && deps != task.dependsOn
        TaskAction.SubmitOutsideResult -> resultText.isNotBlank() && evidenceText.isNotBlank() &&
            resultText.trim().length + evidenceText.trim().length <= 3950
        TaskAction.AddEvidence -> evidenceText.isNotBlank() && task.evidenceState == "missing"
        TaskAction.Retry -> reason.isNotBlank()
        else -> reason.isNotBlank()
    }

    WorkflowActionSheet(
        controller = controller,
        title = label,
        description = (task.title + ". ") + DESCRIPTIONS[action].orEmpty(),
        confirmLabel = label,
        onClose = onClose,
        danger = danger,
        check = check,
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = serverReason == null && inputsValid,
        disabledHint = serverReason ?: "Fill in the fields above, then check again.",
        write = { key ->
            when (action) {
                TaskAction.Prepare -> WorkflowWrites.prepare(d, task, key, criteria, assignee)
                TaskAction.Retry -> WorkflowWrites.retry(d, task, key, reason, assignee?.takeIf { it !in task.assigneeIds })
                TaskAction.Release -> WorkflowWrites.release(
                    d, key, listOf(task.id), mapOf(task.id to (impact?.taskRevisions?.get(task.id) ?: task.workRevision)), holds.toList(), reason,
                )
                TaskAction.Dependencies -> WorkflowWrites.dependencies(d, task, key, deps, reason)
                TaskAction.SubmitOutsideResult -> WorkflowWrites.outsideResult(
                    d, task, key, "Result:\n${resultText.trim()}\n\nEvidence:\n${evidenceText.trim()}", producedBy,
                )
                TaskAction.WithdrawEvidence -> WorkflowWrites.withdrawOutsideResult(d, task, key, reason)
                TaskAction.AddEvidence -> WorkflowWrites.addEvidence(d, task, key, evidenceText)
                else -> WorkflowWrites.taskMutation(d, task, action.route, key, reason)
            }
        },
    ) {
        when (action) {
            TaskAction.Prepare -> {
                OutlinedTextField(criteria, { criteria = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Done when") }, minLines = 2)
                AgentPicker("Assignee", agents, assignee) { assignee = it }
            }
            TaskAction.Retry -> {
                OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason") }, minLines = 2)
                AgentPicker("Reassign for this attempt (optional)", agents, assignee, allowKeep = true) { assignee = it }
            }
            TaskAction.Release -> {
                Text("Holds to release", style = ltype(LType.BodyEmph), color = p.text)
                allowedHolds.forEach { h ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { holds = if (h in holds) holds - h else holds + h }) {
                        Checkbox(h in holds, { holds = if (h in holds) holds - h else holds + h })
                        Text(if (h == "start") "Start hold" else "Human hold" + (task.humanHoldReason?.let { ": $it" } ?: ""), color = p.text)
                    }
                }
                OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason (optional)") })
                impact?.let { ImpactCard(it) }
            }
            TaskAction.Dependencies -> PrerequisitePicker(task, d.tasks, deps) { deps = it; checkedDeps = null }
            TaskAction.SubmitOutsideResult -> {
                Text("Done when: ${task.definitionOfDone}", style = ltype(LType.Meta), color = p.text2)
                OutlinedTextField(resultText, { resultText = it.take(1900) }, Modifier.fillMaxWidth(), label = { Text("Result") }, minLines = 3)
                OutlinedTextField(evidenceText, { evidenceText = it.take(1900) }, Modifier.fillMaxWidth(), label = { Text("Evidence") }, minLines = 2)
                OutlinedTextField(producedBy, { producedBy = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Produced by (optional)") })
            }
            TaskAction.AddEvidence ->
                OutlinedTextField(evidenceText, { evidenceText = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Evidence") }, minLines = 3)
            TaskAction.ReleaseLostWorker -> {
                OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason") }, minLines = 2)
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { riskAccepted = !riskAccepted }) {
                    Checkbox(riskAccepted, { riskAccepted = it })
                    Text("I understand the worker may still be running", color = p.text)
                }
                if (!task.displayState.releaseAvailable) {
                    Text(
                        task.displayState.releaseAvailableAt?.let { "Release becomes available at ${shortTime(it)}." }
                            ?: "Wait until the server confirms that lost-worker release is available.",
                        style = ltype(LType.Meta), color = p.muted,
                    )
                }
            }
            else -> OutlinedTextField(reason, { reason = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Reason") }, minLines = 2)
        }
    }
}

@Composable
internal fun AgentPicker(label: String, agents: List<AgentDto>, selected: String?, allowKeep: Boolean = false, onSelect: (String?) -> Unit) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = ltype(LType.BodyEmph), color = p.text)
        if (allowKeep) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { onSelect(null) }) {
                RadioButton(selected == null, { onSelect(null) })
                Text("Keep the current assignment", color = p.text)
            }
        }
        agents.forEach { a ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { onSelect(a.id) }) {
                RadioButton(selected == a.id, { onSelect(a.id) })
                Text(a.alias, color = p.text)
            }
        }
    }
}

/** W12: the workflow's other tasks with checkboxes (3 max), disabled rows carry the reason. */
@Composable
internal fun PrerequisitePicker(
    task: io.openorcha.mobile.data.WorkflowTaskDto,
    all: List<io.openorcha.mobile.data.WorkflowTaskDto>,
    chosen: List<String>,
    onChange: (List<String>) -> Unit,
) {
    val p = Orcha.palette
    Text("${chosen.size} of ${WorkflowLogic.MAX_PREREQUISITES} prerequisites", style = ltype(LType.Meta), color = p.text2)
    all.filter { it.id != task.id }.forEach { c ->
        val reason = WorkflowLogic.dependencyReason(task, c, all, chosen)
        val on = c.id in chosen
        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable(enabled = on || reason == null) { onChange(if (on) chosen - c.id else chosen + c.id) },
            ) {
                Checkbox(on, { onChange(if (on) chosen - c.id else chosen + c.id) }, enabled = on || reason == null)
                Text(c.title, color = if (on || reason == null) p.text else p.muted)
            }
            if (on) Text("${task.title} will wait for ${c.title} to be accepted.", style = ltype(LType.Meta), color = p.text2, modifier = Modifier.padding(start = 48.dp))
            else reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(start = 48.dp)) }
        }
    }
}
