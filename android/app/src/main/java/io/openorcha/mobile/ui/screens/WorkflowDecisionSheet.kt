package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RoundContextDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.domain.WorkflowLogic.plural
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W20 owner decision (#368; web WorkflowLoopDecision.tsx): a loop at its limit, a stalled
   loop, a step accepted without an outcome, or a rule that asks the owner. Options come from
   the waiting case; each is worded with its numbers and consequence. The server records the
   choice beside the outcome that caused it (POST /api/workflows/{wid}/decisions). */

@Composable
internal fun WorkflowDecisionSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    taskId: String,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val task = d.tasks.firstOrNull { it.id == taskId }
    val wait = task?.awaitingLoopDecision
    // Closing is a side effect: never call it during composition.
    if (task == null || wait == null) {
        LaunchedEffect(Unit) { onClose() }
        return
    }
    val options = WorkflowLogic.DECISION_OPTIONS[wait].orEmpty()
    val group = d.repeatGroups.firstOrNull { it.reviewTask == task.id } ?: d.repeatGroups.firstOrNull { it.id == task.repeatGroupId }
    val used = group?.currentRound ?: 0
    var kind by remember { mutableStateOf(options.firstOrNull()) }
    var extra by remember { mutableIntStateOf(2) }
    var assignee by remember { mutableStateOf<String?>(null) }
    var outcome by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var context by remember { mutableStateOf<RoundContextDto?>(null) }
    LaunchedEffect(task.id, task.workRevision) {
        if (group != null) context = runCatching { controller.repository?.roundContext(task.id) }.getOrNull()
    }

    val title = { id: String? -> d.tasks.firstOrNull { it.id == id }?.title }
    val worker = title(task.routes.firstOrNull { it.destination == "return" }?.destinationTask) ?: "the step it returns to"
    val reported = task.reportedOutcome?.outcome
    val open = task.reportedOutcome?.findings.orEmpty()
    val next = used + 1
    val rounds = used + extra
    val labels = mapOf(
        "raise_limit" to "Allow ${plural(extra, "more round")} (new maximum $rounds, $used used)",
        "reassign_continue" to if (wait == "stalled") "Reassign $worker and resume" else "Reassign $worker, then allow 1 more round",
        "accept_override" to "Accept the work as it is and move on",
        "resume_stalled" to "Resume with guidance for the worker",
        "pick_outcome" to "Choose the outcome",
        "stop" to "Stop the loop",
    )
    val consequences = mapOf(
        "raise_limit" to "Round $next starts with the last review" + (if (open.isNotEmpty()) " and ${plural(open.size, "open finding")}" else "") +
            ". Rounds already used stay counted; this never makes the loop unlimited.",
        "reassign_continue" to "Pick who does $worker in round $next. The review step stays the same.",
        "accept_override" to "Records that you overrode the round-$used review." + (reported?.let { " The original “$it” stays in history beside your decision." } ?: ""),
        "resume_stalled" to "Round $next starts with the same findings and your note." + (group?.let { " Rounds remaining: ${maxOf(it.maxRounds - used, 0)}." } ?: ""),
        "pick_outcome" to "Your choice takes that outcome's rule, as if the step had reported it.",
        "stop" to "Keeps " + (if (used > 0) "all ${plural(used, "round")}" else "the finished work") + ". Later steps that depend on the loop are not needed.",
    )
    val actions = mapOf(
        "raise_limit" to "Allow ${plural(extra, "more round")}", "reassign_continue" to "Reassign and continue",
        "accept_override" to "Accept as it is", "resume_stalled" to "Resume round $next", "pick_outcome" to "Use this outcome", "stop" to "Stop the loop",
    )
    val invalid = WorkflowLogic.decisionInvalid(kind, group, extra, assignee, outcome, note)
    val isOwner = controller.actorId == d.ownerHumanId
    val description = group?.let {
        "${it.name} · $used of ${it.maxRounds} rounds used" + (reported?.let { r -> " · last outcome: $r (round $used)" } ?: "") +
            (if (open.isNotEmpty()) " · ${plural(open.size, "unresolved finding")}" else "")
    } ?: (task.title + (reported?.let { " · reported $it" } ?: ""))

    WorkflowActionSheet(
        controller = controller,
        title = WorkflowLogic.DECISION_TITLES[wait] ?: "Decide what happens next",
        description = description,
        confirmLabel = kind?.let { actions[it] } ?: "Decide",
        onClose = onClose,
        danger = kind == "stop",
        check = null,
        confirmEnabled = invalid == null && isOwner,
        disabledHint = if (!isOwner) "The workflow owner decides what happens next." else invalid,
        successNotice = "Decision recorded",
        write = { key ->
            val k = kind ?: return@WorkflowActionSheet null
            WorkflowWrites.loopDecision(
                d, key, k, task.id,
                newMaxRounds = rounds.takeIf { k == "raise_limit" },
                assigneeId = assignee.takeIf { k == "reassign_continue" },
                outcome = outcome.takeIf { k == "pick_outcome" },
                note = note, reason = note,
            )
        },
    ) {
        if (wait == "stalled" && group != null) {
            val previous = context?.group?.thisRound
            Text("Why Orcha paused: rounds ${used - 1} and $used side by side", style = ltype(LType.BodyEmph), color = p.text)
            RoundCompare("Round ${used - 1}" + (previous?.outcome?.let { " · $it" } ?: ""), previous?.findings?.map { it.text } ?: listOf("Reading the round…"))
            RoundCompare("Round $used" + (reported?.let { " · $it" } ?: ""), listOf("The work it reviewed did not change since round ${used - 1}.") + open.map { it.text })
        }
        if (wait == "limit_reached" && open.isNotEmpty()) {
            RoundCompare("Still open after round $used", open.mapIndexed { i, f -> "${f.id ?: "F${i + 1}"}  ${f.text}" })
        }
        if (wait == "missing_outcome" || wait == "ask_owner") {
            Text(WorkflowLogic.DECISION_HEADINGS[wait].orEmpty() + "." + (task.reportedOutcome?.note?.takeIf { it.isNotBlank() }?.let { " Note: $it" } ?: ""),
                style = ltype(LType.Body), color = p.text2)
        }
        options.forEach { k ->
            Row(
                Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).clickable { kind = k }.padding(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                RadioButton(kind == k, { kind = k })
                Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(labels[k].orEmpty(), style = ltype(LType.Body), color = if (k == "stop") p.danger else p.text)
                    Text(consequences[k].orEmpty(), style = ltype(LType.Meta), color = p.text2)
                }
            }
        }
        when (kind) {
            "raise_limit" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("More rounds", color = p.text)
                LButton("−", { if (extra > 1) extra-- }, kind = LButtonKind.Secondary, enabled = extra > 1)
                Text("$extra", style = ltype(LType.BodyEmph), color = p.text)
                LButton("+", { if (used + extra < 20) extra++ }, kind = LButtonKind.Secondary, enabled = used + extra < 20)
            }
            "reassign_continue" -> AgentPicker("Assign $worker to", snapshot.agents, assignee) { assignee = it }
            "pick_outcome" -> Column {
                Text("Outcome", style = ltype(LType.BodyEmph), color = p.text)
                WorkflowLogic.pickableOutcomes(task).forEach { o ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { outcome = o }) {
                        RadioButton(outcome == o, { outcome = o })
                        val route = task.routes.firstOrNull { it.outcome.equals(o, ignoreCase = true) }
                        Text(route?.let { WorkflowLogic.routeSentence(it, title) } ?: o, color = p.text)
                    }
                }
            }
        }
        OutlinedTextField(
            note, { note = it.take(4000) }, Modifier.fillMaxWidth(),
            label = { Text(if (kind == "resume_stalled") "Note to the worker" else "Reason (shown in Activity)") }, minLines = 2,
        )
    }
}

@Composable
private fun RoundCompare(header: String, lines: List<String>) {
    val p = Orcha.palette
    Column(
        Modifier.fillMaxWidth().background(p.surface2, RoundedCornerShape(p.radiusCard.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(header, style = ltype(LType.BodyEmph), color = p.text)
        lines.forEach { Text(it, style = ltype(LType.Meta), color = p.text2) }
    }
}
