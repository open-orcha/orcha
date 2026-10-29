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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.EvidenceItemRefDto
import io.openorcha.mobile.data.EvidenceReferenceDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowNewTaskBody
import io.openorcha.mobile.data.WorkflowTaskEvidenceDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import java.util.UUID

/* W25 Record review outcome — the web's WorkflowReviewEditor: review sequence (existing loop or
   a new one) · review task · reviewed task · its current saved evidence · outcome · optional
   fresh correction + follow-up review pair. POST /api/workflows/{wid}/review-rounds. */

private val ROUND_OUTCOMES = listOf("changes_requested" to "Changes requested", "accepted" to "Accepted", "inconclusive" to "Inconclusive")

private data class NewTaskDraft(val key: String = UUID.randomUUID().toString(), val title: String = "", val criteria: String = "", val assignee: String? = null) {
    val complete: Boolean get() = title.isNotBlank() && criteria.isNotBlank() && assignee != null
    fun body() = WorkflowNewTaskBody(clientKey = key, title = title.trim(), definitionOfDone = criteria.trim(), assigneeId = assignee, priority = 100)
}

@Composable
internal fun WorkflowReviewRoundSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository ?: return
    val workers: List<AgentDto> = snapshot.agents.filter { it.kind != "human" }
    val loops = remember(d.reviewRounds) {
        d.reviewRounds.sortedBy { it.roundNumber }.associateBy { it.loopKey }.values.toList()
    }
    val newLoop = remember { UUID.randomUUID().toString() }
    var loop by remember { mutableStateOf("") }
    var review by remember { mutableStateOf("") }
    var reviewed by remember { mutableStateOf("") }
    var outcome by remember { mutableStateOf("changes_requested") }
    var pair by remember { mutableStateOf(false) }
    var correction by remember { mutableStateOf(NewTaskDraft()) }
    var next by remember { mutableStateOf(NewTaskDraft()) }
    var evidence by remember { mutableStateOf<WorkflowTaskEvidenceDto?>(null) }
    var reference by remember { mutableStateOf<EvidenceReferenceDto?>(null) }

    LaunchedEffect(reviewed) {
        evidence = null
        reference = null
        if (reviewed.isNotEmpty()) evidence = runCatching { repo.taskEvidence(d.id, reviewed) }.getOrNull()
    }

    val serverReason = WorkflowLogic.actionReason(d, "review_round", controller.hasHuman)
    val withPair = pair && outcome == "changes_requested"
    val invalid = when {
        review.isEmpty() || reviewed.isEmpty() || reference == null -> "Choose the review task, the task it reviewed and its current saved evidence."
        withPair && !(correction.complete && next.complete) -> "Give both new tasks a title, completion criteria and assignee."
        else -> null
    }
    val revisionAtOpen = remember { d.revision }

    WorkflowActionSheet(
        controller = controller,
        title = "Record review outcome",
        description = "The review outcome records findings. Acceptance of the delivered report is a separate action. Corrections and follow-up reviews use fresh tasks.",
        confirmLabel = "Record review outcome",
        onClose = onClose,
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: (controller.state.value.detail ?: d).let { latest ->
                    WorkflowLogic.actionReason(latest, "review_round", controller.hasHuman)
                        ?: if (latest.revision != revisionAtOpen) "The workflow changed. Refresh before confirming the review outcome." else null
                }
        },
        checkedNote = (if (withPair) "Two fresh tasks will be requested as one change, subject to workflow limits. Existing reviews are not reopened."
            else "Record the outcome without adding tasks.") + " Goal acceptance will need review again. This does not finish the workflow.",
        confirmEnabled = serverReason == null && invalid == null,
        disabledHint = serverReason ?: invalid,
        write = { key ->
            reference?.let { ref ->
                WorkflowWrites.reviewRound(
                    d, key, loop.ifEmpty { newLoop }, review, reviewed, ref, outcome,
                    correction.body().takeIf { withPair }, next.body().takeIf { withPair }, null,
                )
            }
        },
    ) {
        Text("Review sequence", style = ltype(LType.BodyEmph), color = p.text)
        Choice("New review sequence", loop.isEmpty()) { loop = ""; reference = null }
        loops.forEach { r ->
            val title = d.tasks.firstOrNull { it.id == r.reviewTaskId }?.title ?: "Review sequence"
            Choice("$title — round ${r.roundNumber}", loop == r.loopKey) { loop = r.loopKey; review = r.reviewTaskId; reference = null }
        }
        Text("Review task", style = ltype(LType.BodyEmph), color = p.text)
        if (loop.isNotEmpty()) Text(d.tasks.firstOrNull { it.id == review }?.title.orEmpty(), color = p.text2)
        else d.tasks.forEach { t -> Choice(t.title, review == t.id) { review = t.id } }
        Text("Task that was reviewed", style = ltype(LType.BodyEmph), color = p.text)
        d.tasks.forEach { t -> Choice(t.title, reviewed == t.id) { reviewed = t.id } }
        if (reviewed.isNotEmpty()) {
            val sets = evidence?.sets.orEmpty().filter { it.state == "saved" }
            if (evidence == null) Text("Loading saved evidence…", style = ltype(LType.Meta), color = p.muted)
            else if (sets.isEmpty()) Text("This task has no saved evidence to review.", style = ltype(LType.Meta), color = p.muted)
            sets.forEach { set ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable {
                    reference = EvidenceReferenceDto(set.evidenceSetId, set.items.map { EvidenceItemRefDto(it.itemId, it.deliverableId, it.deliverableVersion, it.sha256) })
                }) {
                    RadioButton(reference?.evidenceSetId == set.evidenceSetId, null)
                    Column { EvidenceSetCard(set, current = set.evidenceSetId == evidence?.currentEvidenceSetId) }
                }
            }
        }
        Text("Review outcome", style = ltype(LType.BodyEmph), color = p.text)
        ROUND_OUTCOMES.forEach { (k, l) -> Choice(l, outcome == k) { outcome = k } }
        if (outcome == "changes_requested") {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { pair = !pair }) {
                Checkbox(pair, null)
                Text("Add a fresh correction and follow-up review together", color = p.text)
            }
            if (pair) {
                NewTaskFields("Correction task", "Depends on acceptance of the current review report. Task autonomy OFF.", correction, workers) { correction = it }
                NewTaskFields("Follow-up review task", "Depends on acceptance of the correction. Task autonomy OFF.", next, workers) { next = it }
            }
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        RadioButton(selected, onClick)
        Text(label, color = Orcha.palette.text)
    }
}

@Composable
private fun NewTaskFields(legend: String, note: String, t: NewTaskDraft, workers: List<AgentDto>, onChange: (NewTaskDraft) -> Unit) {
    val p = Orcha.palette
    Text(legend, style = ltype(LType.BodyEmph), color = p.text)
    OutlinedTextField(t.title, { onChange(t.copy(title = it.take(200))) }, Modifier.fillMaxWidth(), label = { Text("Title") }, singleLine = true)
    OutlinedTextField(t.criteria, { onChange(t.copy(criteria = it.take(4000))) }, Modifier.fillMaxWidth(), label = { Text("Done when") }, minLines = 2)
    AgentPicker("Assignee", workers, t.assignee) { onChange(t.copy(assignee = it)) }
    Text(note, style = ltype(LType.Meta), color = p.muted)
}
