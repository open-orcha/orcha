package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.EvidenceBasisDto
import io.openorcha.mobile.data.EvidenceItemRefDto
import io.openorcha.mobile.data.EvidenceReferenceDto
import io.openorcha.mobile.data.SavedEvidenceSetDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/* W13 acceptance forms (web WorkflowAcceptance): accept an objective ([objectiveId]) or the
   goal (null) against the current saved evidence of chosen tasks. Acceptance does not finish
   the workflow; Finish stays its own action. */

/** One picked task: its work revision and the exact saved evidence set to record. */
private data class EvidencePick(val revision: Int, val reference: EvidenceReferenceDto)

private fun usable(set: SavedEvidenceSetDto, revision: Int) =
    set.state == "saved" && set.purpose == "acceptance" && set.workRevision == revision &&
        set.items.isNotEmpty() && set.items.all { it.storageState == "readable" }

@Composable
internal fun WorkflowAcceptanceSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    objectiveId: String?,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository
    val objective = objectiveId?.let { id -> d.objectives.firstOrNull { it.id == id } }
    if (repo == null || (objectiveId != null && objective == null)) {
        LaunchedEffect(Unit) { onClose() }
        return
    }
    val action = if (objectiveId != null) "accept_objective" else "accept_goal"
    val scope = rememberCoroutineScope()
    var narrative by rememberSaveable { mutableStateOf("") }
    var picks by remember { mutableStateOf<Map<String, EvidencePick>>(emptyMap()) }
    var pickError by remember { mutableStateOf<String?>(null) }
    val reasonFor = { w: WorkflowDetailDto ->
        if (objectiveId != null) WorkflowLogic.objectiveActionReason(w, objectiveId, action, controller.hasHuman)
        else WorkflowLogic.actionReason(w, action, controller.hasHuman)
    }
    val invalid = when {
        !d.evidenceCapability.available -> "Saved evidence must be available before acceptance."
        narrative.isBlank() || picks.isEmpty() -> "Explain the decision and select the current saved evidence before reviewing."
        else -> null
    }
    val serverReason = reasonFor(d)

    WorkflowActionSheet(
        controller = controller,
        title = if (objective != null) "Accept objective" else "Accept goal",
        description = "This records acceptance against the selected task revisions and exact saved file versions. It does not finish the workflow.",
        confirmLabel = if (objective != null) "Accept objective" else "Accept goal",
        onClose = onClose,
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: (controller.state.value.detail ?: d).let { latest ->
                    reasonFor(latest) ?: if (picks.any { (id, pick) ->
                            val t = latest.tasks.firstOrNull { it.id == id }
                            t == null || t.workRevision != pick.revision || t.currentEvidenceSetId != pick.reference.evidenceSetId
                        }
                    ) "The selected evidence changed. Read the current saved evidence and select it again." else null
                }
        },
        inputs = narrative to picks,
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = serverReason == null && invalid == null,
        disabledHint = serverReason ?: invalid,
        successNotice = if (objective != null) "Objective accepted." else "Goal accepted.",
        write = { key ->
            val latest = controller.state.value.detail ?: d
            val basis = EvidenceBasisDto(
                narrative.trim(),
                picks.mapValues { it.value.revision },
                picks.values.map { it.reference },
            )
            if (objectiveId != null) WorkflowWrites.acceptObjective(latest, objectiveId, key, basis)
            else WorkflowWrites.acceptGoal(latest, key, basis)
        },
    ) {
        objective?.let {
            Text(it.title, style = ltype(LType.BodyEmph), color = p.text)
            if (it.criteria.isNotBlank()) Text(it.criteria, style = ltype(LType.Meta), color = p.text2)
        } ?: Text(d.goal, style = ltype(LType.Body), color = p.text2)
        if (!d.evidenceCapability.available) {
            Text("Saved evidence is unavailable on this connection. Acceptance and Finish remain unavailable.", color = p.muted)
        }
        Text("Evidence", style = ltype(LType.BodyEmph), color = p.text)
        val candidates = d.tasks.filter { it.withdrawnAt == null && it.currentEvidenceSetId != null }
        if (candidates.isEmpty()) Text("No task has saved evidence yet.", color = p.muted)
        candidates.forEach { t ->
            val on = t.id in picks
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable {
                    if (on) { picks = picks - t.id; return@clickable }
                    pickError = null
                    scope.launch {
                        runCatching { repo.taskEvidence(d.id, t.id) }.onSuccess { page ->
                            val set = page.sets.firstOrNull { it.evidenceSetId == page.currentEvidenceSetId }
                            if (set != null && usable(set, t.workRevision) && t.currentEvidenceSetId == set.evidenceSetId) {
                                val ref = EvidenceReferenceDto(
                                    set.evidenceSetId,
                                    set.items.map { EvidenceItemRefDto(it.itemId, it.deliverableId, it.deliverableVersion, it.sha256) },
                                )
                                picks = picks + (t.id to EvidencePick(t.workRevision, ref))
                            } else {
                                pickError = "Evidence missing or changed for ${t.title} — refresh the task or add evidence before accepting."
                            }
                        }.onFailure { pickError = it.message ?: "Saved evidence could not be read." }
                    }
                },
            ) {
                Checkbox(on, null)
                Text("Use current saved evidence from ${t.title}", color = p.text)
            }
        }
        pickError?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
        Text("${picks.size} current saved evidence sets selected. Missing or stale files cannot be accepted.", style = ltype(LType.Meta), color = p.text2)
        OutlinedTextField(
            narrative, { narrative = it.take(4000) }, Modifier.fillMaxWidth(),
            label = { Text("Why this is accepted") }, minLines = 2,
        )
    }
}
