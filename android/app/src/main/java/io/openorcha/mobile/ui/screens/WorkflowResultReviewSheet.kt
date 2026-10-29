package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.EvidenceItemRefDto
import io.openorcha.mobile.data.EvidenceReferenceDto
import io.openorcha.mobile.data.RoutingPreviewDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowTaskEvidenceDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W09 result review and outcome report: for a task in needs_verification. Accept and
   Request changes go through the workflow routes, never the legacy verify. When the step
   declares outcomes, the assigned reporter picks one (with findings) and "Review decision"
   previews where it leads (POST /api/tasks/{tid}/outcome/preview) before the confirm. */

private enum class ReviewDecision { Accept, Reject, Outcome }

@Composable
internal fun WorkflowResultReviewSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    taskId: String,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val task = d.tasks.firstOrNull { it.id == taskId } ?: return onClose()
    val repo = controller.repository ?: return
    var evidence by remember { mutableStateOf<WorkflowTaskEvidenceDto?>(null) }
    var evidenceError by remember { mutableStateOf<String?>(null) }
    var useCurrent by remember { mutableStateOf(false) }
    val hasOutcomes = task.outcomes.isNotEmpty()
    val canReport = task.availableActions.any { it.action == "report_outcome" && it.enabled }
    var decision by remember { mutableStateOf(if (hasOutcomes && canReport) ReviewDecision.Outcome else ReviewDecision.Accept) }
    var outcome by remember { mutableStateOf<String?>(null) }
    val findings = remember { mutableStateListOf<String>() }
    var note by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<RoutingPreviewDto?>(null) }

    LaunchedEffect(task.id, task.workRevision) {
        runCatching { repo.taskEvidence(d.id, task.id) }
            .onSuccess { evidence = it; evidenceError = null }
            .onFailure { evidenceError = it.message }
    }
    val current = evidence?.sets?.firstOrNull { it.evidenceSetId == (evidence?.currentEvidenceSetId ?: task.currentEvidenceSetId) }
    val reference = current?.takeIf { it.state == "saved" }?.let { set ->
        EvidenceReferenceDto(set.evidenceSetId, set.items.map { EvidenceItemRefDto(it.itemId, it.deliverableId, it.deliverableVersion, it.sha256) })
    }
    val title = { id: String? -> d.tasks.firstOrNull { it.id == id }?.title }

    val (confirmLabel, enabled, hint) = when (decision) {
        ReviewDecision.Accept -> Triple(
            "Accept result",
            reference != null && useCurrent && task.availableActions.any { it.action == "accept" && it.enabled },
            when {
                reference == null -> "Wait for evidence to finish saving before accepting."
                !useCurrent -> "Tick “Use current saved evidence” to accept."
                else -> io.openorcha.mobile.domain.WorkflowLogic.taskActionReason(d, task, "accept", controller.hasHuman)
            },
        )
        ReviewDecision.Reject -> Triple(
            "Request changes",
            note.isNotBlank() && task.availableActions.any { it.action == "reject" && it.enabled },
            if (note.isBlank()) "Write what needs to change." else io.openorcha.mobile.domain.WorkflowLogic.taskActionReason(d, task, "reject", controller.hasHuman),
        )
        ReviewDecision.Outcome -> Triple(
            "Report ${outcome ?: "outcome"}",
            outcome != null && preview?.outcome == outcome && canReport,
            if (outcome == null) "Choose an outcome." else "Review the decision first.",
        )
    }

    WorkflowActionSheet(
        controller = controller,
        title = "Review result: ${task.title}",
        description = "This decision is about the finished result, separate from its plan approval. Accepting a result never finishes the workflow.",
        confirmLabel = confirmLabel,
        onClose = onClose,
        danger = decision == ReviewDecision.Reject,
        checkLabel = "Review decision",
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: if (decision == ReviewDecision.Outcome && outcome != null) {
                    checkRead({ repo.previewOutcome(task.id, outcome!!, task.workRevision) }) { preview = it }
                } else null
        },
        confirmEnabled = enabled,
        disabledHint = hint,
        successNotice = when (decision) {
            ReviewDecision.Accept -> "Result accepted"
            ReviewDecision.Reject -> "Changes requested"
            ReviewDecision.Outcome -> "Outcome reported"
        },
        write = { key ->
            when (decision) {
                ReviewDecision.Accept -> reference?.let { WorkflowWrites.accept(d, task, key, it, note) }
                ReviewDecision.Reject -> WorkflowWrites.taskMutation(d, task, "reject", key, note)
                ReviewDecision.Outcome -> outcome?.let { WorkflowWrites.reportOutcome(d, task, key, it, findings.toList(), note) }
            }
        },
    ) {
        Text("Done when: ${task.definitionOfDone}", style = ltype(LType.Body), color = p.text2)
        Text("Work revision ${task.workRevision}", style = ltype(LType.Meta), color = p.text2)
        evidenceError?.let { Banner(BannerKind.Warn, it) }
        when (current?.state) {
            null -> if (evidence != null) Banner(BannerKind.Warn, "No saved evidence for the current result yet.")
            "pending" -> Banner(BannerKind.Warn, "Evidence is still saving. Wait before accepting.")
            "missing" -> Banner(BannerKind.Warn, "The current result's evidence is missing. Replace it before accepting.")
            else -> Unit
        }
        evidence?.sets?.take(3)?.forEach { EvidenceSetCard(it, it.evidenceSetId == current?.evidenceSetId) }
        if (reference != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { useCurrent = !useCurrent }) {
                Checkbox(useCurrent, { useCurrent = it })
                Text("Use current saved evidence", color = p.text)
            }
        }
        if (hasOutcomes) {
            Text("Outcome", style = ltype(LType.BodyEmph), color = p.text)
            if (!canReport) {
                Text("Waiting for the assigned reviewer to report an outcome.", style = ltype(LType.Meta), color = p.muted)
            } else {
                task.outcomes.forEach { o ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { outcome = o.name; decision = ReviewDecision.Outcome; preview = null }) {
                        RadioButton(outcome == o.name && decision == ReviewDecision.Outcome, { outcome = o.name; decision = ReviewDecision.Outcome; preview = null })
                        val route = task.routes.firstOrNull { it.outcome.equals(o.name, ignoreCase = true) }
                        Text(route?.let { io.openorcha.mobile.domain.WorkflowLogic.routeSentence(it, title) } ?: o.name, color = p.text)
                    }
                }
                Text("Findings", style = ltype(LType.BodyEmph), color = p.text)
                findings.forEachIndexed { i, f ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(f, { findings[i] = it.take(4000) }, Modifier.weight(1f), label = { Text("Finding ${i + 1}") })
                        LButton("Remove", { findings.removeAt(i) }, kind = LButtonKind.Ghost)
                    }
                }
                LButton("Add finding", { findings.add("") }, kind = LButtonKind.Secondary)
                Text("Reporting an outcome cannot change the success criteria.", style = ltype(LType.Meta), color = p.muted)
            }
        }
        Text("Decision", style = ltype(LType.BodyEmph), color = p.text)
        listOf(
            ReviewDecision.Accept to "Accept result — the result counts toward the workflow.",
            ReviewDecision.Reject to "Request changes — the task goes back with your note.",
        ).forEach { (dec, text) ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { decision = dec; preview = null }) {
                RadioButton(decision == dec, { decision = dec; preview = null })
                Text(text, color = p.text)
            }
        }
        OutlinedTextField(
            note, { note = it.take(4000) }, Modifier.fillMaxWidth(), minLines = 2,
            label = { Text(if (decision == ReviewDecision.Reject) "What needs to change" else "Note (optional)") },
        )
        preview?.let { pv ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(pv.message, style = ltype(LType.Body), color = p.text)
                if (pv.repeats.isNotEmpty()) Text("Repeats: " + pv.repeats.mapNotNull(title).joinToString(", "), style = ltype(LType.Meta), color = p.text2)
                if (pv.stale.isNotEmpty()) Text("Becomes stale: " + pv.stale.mapNotNull(title).joinToString(", ") + ". A late result cannot satisfy the new round.", style = ltype(LType.Meta), color = p.warn)
                pv.roundsRemaining?.let { Text("Rounds remaining: $it", style = ltype(LType.Meta), color = p.text2) }
                if (pv.blockedBy == "limit") Text("The round limit blocks another round; the owner decides.", style = ltype(LType.Meta), color = p.warn)
            }
        }
    }
}

private val Int.dp get() = androidx.compose.ui.unit.Dp(this.toFloat())
