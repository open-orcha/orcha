package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RoundContextDto
import io.openorcha.mobile.data.SavedEvidenceSetDto
import io.openorcha.mobile.data.TaskAcceptanceDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowTaskEvidenceDto
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.ui.WorkflowOperation
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/* W06 task sheet (replaces the web inspector): header · state with blockers and round
   context · actions (enabled first, then "Not available now" with every server reason) ·
   prerequisites · acceptance record · saved evidence · discussion · task authority line. */

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun WorkflowTaskSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    taskId: String,
    onClose: () -> Unit,
    onAction: (WorkflowLogic.TaskAction) -> Unit,
    onReviewResult: () -> Unit,
    onDecide: () -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenTaskSheet: (String) -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val task = d.tasks.firstOrNull { it.id == taskId }
    // Closing is a side effect: never call it during composition.
    if (task == null) {
        LaunchedEffect(Unit) { onClose() }
        return
    }
    val repo = controller.repository ?: return
    val nameOf = { id: String? -> snapshot.agents.firstOrNull { it.id == id }?.alias }
    val titleOf = { id: String? -> d.tasks.firstOrNull { it.id == id }?.title }
    val frozen = s.operation is WorkflowOperation.Sending || s.operation is WorkflowOperation.Uncertain || s.detailStale
    var round by remember { mutableStateOf<RoundContextDto?>(null) }
    var evidence by remember { mutableStateOf<WorkflowTaskEvidenceDto?>(null) }
    var evidenceError by remember { mutableStateOf<String?>(null) }
    var showMore by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(task.id, task.workRevision) {
        if (task.repeatGroupId != null || task.outcomes.isNotEmpty()) round = runCatching { repo.roundContext(task.id) }.getOrNull()
        runCatching { repo.taskEvidence(d.id, task.id) }.onSuccess { evidence = it; evidenceError = null }.onFailure { evidenceError = it.message }
    }

    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheetState, containerColor = p.bg) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // 1. Header
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LStatusGlyph(task.status, Modifier.padding(top = 4.dp))
                Text(task.title, style = ltype(LType.Headline), color = p.text, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                IconButton(onClick = { onClose(); onOpenTask(task.id) }) { Icon(OrchaIcons.OpenInNew, "Open task page", tint = p.text2) }
                IconButton(onClick = onClose) { Icon(OrchaIcons.Close, "Close", tint = p.text2) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                task.assigneeIds.forEach { id -> LAvatar(nameOf(id) ?: "?", size = 20.dp); Text(nameOf(id) ?: "Unknown", style = ltype(LType.Meta), color = p.text2) }
                if (task.assigneeIds.isEmpty()) Text("Unassigned", style = ltype(LType.Meta), color = p.muted)
                LTag("Autonomy ${task.autonomy.uppercase()}")
                Text(task.id.take(8), style = ltype(LType.Mono), color = p.muted)
            }

            // 2. State
            Section("State") {
                Text(task.displayState.label, style = ltype(LType.BodyEmph), color = p.text)
                task.blockers.forEach { Text("• ${it.message}", style = ltype(LType.Body), color = p.text2) }
                task.displayState.warning?.let { Banner(BannerKind.Warn, it) }
                task.displayState.releaseAvailableAt?.let { Text("Release lost worker becomes available at ${shortTime(it)}.", style = ltype(LType.Meta), color = p.text2) }
                task.humanHoldReason?.let { Text("On hold: $it" + (nameOf(task.humanHoldBy)?.let { n -> " ($n)" } ?: ""), style = ltype(LType.Meta), color = p.text2) }
                round?.group?.let { g ->
                    Text("Round ${g.round} of ${g.maxRounds} · ${g.name}", style = ltype(LType.BodyEmph), color = p.text)
                    Text("Exits when ${g.reviewStep ?: "the review"} reports ${g.exitOutcome}.", style = ltype(LType.Meta), color = p.text2)
                    g.thisRound.trigger?.let { Text("Why it runs: $it", style = ltype(LType.Meta), color = p.text2) }
                    if (g.thisRound.findings.isNotEmpty()) {
                        Text("Received this round", style = ltype(LType.Meta), color = p.text2)
                        g.thisRound.findings.forEach { f -> Text("• ${f.text}", style = ltype(LType.Body), color = p.text) }
                    }
                    g.thisRound.ownerNote?.let { Text("Owner note: $it", style = ltype(LType.Meta), color = p.text2) }
                }
                if (task.awaitingLoopDecision != null) {
                    val owner = controller.actorId == d.ownerHumanId
                    Text(
                        (WorkflowLogic.DECISION_HEADINGS[task.awaitingLoopDecision] ?: "Waiting for the owner") +
                            if (owner) "." else ". The workflow owner decides what happens next.",
                        style = ltype(LType.Body), color = p.warn,
                    )
                    if (owner) LButton("Decide…", onDecide, kind = LButtonKind.Primary, enabled = !frozen)
                }
            }

            // 3. Actions
            val rows = WorkflowLogic.taskActions(d, task, controller.hasHuman)
            Section("Actions") {
                if (WorkflowLogic.canReviewResult(task)) {
                    LButton("Review result…", onReviewResult, Modifier.fillMaxWidth(), kind = LButtonKind.Primary, enabled = !frozen)
                }
                val enabled = rows.filter { it.reason == null }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    enabled.filter { it.action.group != WorkflowLogic.MORE || showMore }.forEach { r ->
                        LButton(
                            WorkflowLogic.taskActionLabel(task, r.action) + "…", { onAction(r.action) },
                            kind = if (r.action.group == WorkflowLogic.DANGER) LButtonKind.Danger else LButtonKind.Secondary,
                            enabled = !frozen,
                        )
                    }
                    if (!showMore && enabled.any { it.action.group == WorkflowLogic.MORE }) {
                        LButton("More", { showMore = true }, kind = LButtonKind.Ghost)
                    }
                }
                val disabled = rows.filter { it.reason != null }
                if (disabled.isNotEmpty()) {
                    Text("Not available now", style = ltype(LType.Meta), color = p.text2)
                    disabled.forEach { r -> Text("${WorkflowLogic.taskActionLabel(task, r.action)}: ${r.reason}", style = ltype(LType.Meta), color = p.muted) }
                }
                if (rows.isEmpty() && !WorkflowLogic.canReviewResult(task)) Text("No actions for this task right now.", style = ltype(LType.Meta), color = p.muted)
            }

            // 4. Prerequisites
            Section("Prerequisites") {
                Text("Depends on", style = ltype(LType.Meta), color = p.text2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (task.dependsOn.isEmpty()) Text("Nothing", style = ltype(LType.Meta), color = p.muted)
                    task.dependsOn.forEach { id -> LChip(titleOf(id) ?: "Task", onClick = { onOpenTaskSheet(id) }) }
                }
                val neededBy = d.tasks.filter { task.id in it.dependsOn }
                Text("Needed by", style = ltype(LType.Meta), color = p.text2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (neededBy.isEmpty()) Text("Nothing", style = ltype(LType.Meta), color = p.muted)
                    neededBy.forEach { t -> LChip(t.title, onClick = { onOpenTaskSheet(t.id) }) }
                }
                task.routes.forEach { r -> Text(WorkflowLogic.routeSentence(r, titleOf), style = ltype(LType.Meta), color = p.text2) }
            }

            // 5. Acceptance record + saved evidence
            task.acceptance?.let { Section("Acceptance record") { AcceptanceRecord(it) } }
            Section("Saved evidence") {
                evidenceError?.let { Banner(BannerKind.Warn, it, action = "Refresh", onAction = {
                    controller.refreshDetail()
                }) }
                val sets = evidence?.sets.orEmpty()
                if (evidence != null && sets.isEmpty()) Text("No saved evidence yet.", style = ltype(LType.Meta), color = p.muted)
                sets.forEach { EvidenceSetCard(it, it.evidenceSetId == evidence?.currentEvidenceSetId) }
                if (evidence?.nextBeforeRevision != null) {
                    val scope = rememberCoroutineScope()
                    LButton("Load earlier evidence", {
                        scope.launch {
                            runCatching { repo.taskEvidence(d.id, task.id, evidence?.nextBeforeRevision) }.getOrNull()?.let { more ->
                                evidence = evidence?.copy(sets = (evidence?.sets.orEmpty() + more.sets).distinctBy { it.evidenceSetId }, nextBeforeRevision = more.nextBeforeRevision)
                            }
                        }
                    }, kind = LButtonKind.Ghost)
                }
            }

            // 6. Discussion
            Section("Discussion") { WorkflowDiscussion(controller, task.id) }

            // 7. Task authority
            Text(
                if (task.autonomy == "on") "Task authority: Autonomy ON — the agent acts without asking for plan or result approval."
                else "Task authority: Autonomy OFF — the agent asks for plan approval and a human verifies finished work.",
                style = ltype(LType.Meta), color = p.text2,
            )
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = ltype(LType.BodyEmph), color = p.text)
        content()
    }
}

@Composable
internal fun AcceptanceRecord(a: TaskAcceptanceDto) {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("Accepted by ${a.actorAlias} (${a.actorKind}) · revision ${a.workRevision} · ${relativeAge(a.acceptedAt)} ago", style = ltype(LType.Meta), color = p.text)
        Text("Autonomy at acceptance: ${a.autonomyAtAcceptance.uppercase()} · ${a.acceptanceSource.replace('_', ' ')}", style = ltype(LType.Meta), color = p.text2)
        a.evidenceItems.forEach { i ->
            Text(
                "v${i.deliverableVersion} · ${i.sha256.take(8)}" + (i.storageState?.let { " · ${it.replace('_', ' ')}" } ?: "") +
                    (i.capturedByAlias?.let { " · by $it" } ?: ""),
                style = ltype(LType.Mono), color = p.text2,
            )
        }
    }
}

@Composable
internal fun EvidenceSetCard(set: SavedEvidenceSetDto, current: Boolean) {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
            LTag(if (current) "Current" else "Earlier")
            LTag(set.state.replaceFirstChar { it.uppercase() }, tint = when (set.state) { "saved" -> p.ok; "missing" -> p.danger; "pending" -> p.warn; else -> null })
            Text("Work revision ${set.workRevision} · result ${set.resultRevision}", style = ltype(LType.Meta), color = p.text2)
        }
        set.missingReason?.let { Text(it, style = ltype(LType.Meta), color = p.warn) }
        set.items.forEach { i ->
            Text(
                "${i.kind?.replace('_', ' ') ?: "file"} · v${i.deliverableVersion} · ${i.sha256.take(8)} · ${i.source ?: ""} ${i.snapshotPhase ?: ""}".trim() +
                    (i.capturedByAlias?.let { " · $it" } ?: "") + if (i.complete == false) " · incomplete" else "",
                style = ltype(LType.Mono), color = p.text2,
            )
        }
    }
}

/** The task thread inside the sheet (flows/05 bubbles, compact): read latest page, post as the paired human. */
@Composable
private fun WorkflowDiscussion(controller: WorkflowsController, taskId: String) {
    val p = Orcha.palette
    var messages by remember { mutableStateOf<List<TaskMessageDto>?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(taskId) { messages = controller.taskMessages(taskId) }
    messages?.takeLast(10)?.forEach { m ->
        Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(8.dp)) {
            Text(m.authorAlias ?: "Someone", style = ltype(LType.Meta), color = p.text2)
            Text(m.body, style = ltype(LType.Body), color = p.text)
        }
    }
    if (messages == null) Text("Loading the thread…", style = ltype(LType.Meta), color = p.muted)
    error?.let { Banner(BannerKind.Danger, it) }
    if (controller.hasHuman) {
        OutlinedTextField(draft, { draft = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Message") }, minLines = 1)
        LButton(if (sending) "Sending…" else "Send", {
            sending = true
            error = null
            scope.launch {
                val ok = controller.postTaskMessage(taskId, draft.trim())
                sending = false
                if (ok) { draft = ""; messages = controller.taskMessages(taskId) } else error = "Couldn't send. Your draft is kept."
            }
        }, enabled = draft.isNotBlank() && !sending, kind = LButtonKind.Secondary)
    }
}
