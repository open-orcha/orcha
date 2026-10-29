package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.ui.WorkflowCreateDraft
import io.openorcha.mobile.ui.WorkflowCreateDraft.Step
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

/* W10 create workflow: Goal → Steps (outcomes, what happens next, repeat group) → Review and
   save. The draft lives in the controller while the app stays open; nothing starts until the
   owner reviews Start. Saves through POST /api/containers/{cid}/workflows (WorkflowCreate,
   semantics_version 2); the phone never calls PUT /flow in v1 (design #373 W05/W10). */

private val PAGES = listOf("Goal", "Steps", "Review")
private val OUTCOME_SUGGESTIONS = listOf("Pass", "Changes requested", "Blocked")
private val DESTINATIONS = listOf(
    "next" to "Next step",
    "step" to "A step…",
    "return" to "Back to the step under review",
    "ask_owner" to "Ask the owner",
    "exit_group" to "Exit the repeat group",
    "stop" to "End of route",
)

@Composable
internal fun WorkflowCreateScreen(
    controller: WorkflowsController,
    agents: List<AgentDto>,
    humanId: String?,
    onClose: () -> Unit,
    onSaved: (WorkflowDetailDto) -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val draft = remember { controller.createDraft() }
    val repo = controller.repository
    val scope = rememberCoroutineScope()
    val workers = agents.filter { it.kind != "human" }
    val humans = agents.filter { it.kind == "human" }
    var confirmDiscard by remember { mutableStateOf(false) }
    var reviewing by remember { mutableStateOf(false) }
    val sending = s.operation is WorkflowOperation.Sending || s.operation is WorkflowOperation.Uncertain

    BackHandler {
        when {
            sending -> controller.notify("Still saving — keep this screen open.")
            draft.page > 0 -> draft.page -= 1
            else -> onClose()
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        DetailTopRow("New workflow", onBack = { if (!sending) onClose() })
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PAGES.forEachIndexed { i, label ->
                Text(
                    "${i + 1}. $label",
                    style = ltype(if (i == draft.page) LType.BodyEmph else LType.Meta),
                    color = if (i == draft.page) p.text else p.muted,
                )
            }
        }
        Text(
            "Draft kept while this app stays open. Nothing starts until you review Start.",
            style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
        s.operation?.let { OperationNotice(it, controller) }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (draft.page) {
                0 -> GoalPage(draft, humanId, humans)
                1 -> StepsPage(draft, workers, humans)
                else -> ReviewPage(draft)
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LButton("Discard draft…", onClick = { confirmDiscard = true }, kind = LButtonKind.Ghost, enabled = !sending)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
                when (draft.page) {
                    0 -> LButton("Next", onClick = { draft.page = 1 }, kind = LButtonKind.Primary, enabled = draft.goalReady)
                    1 -> LButton("Next", onClick = { draft.page = 2 }, kind = LButtonKind.Primary, enabled = draft.stepsReady)
                    else -> if (!draft.reviewedClean) {
                        LButton(
                            if (reviewing) "Reviewing…" else "Review draft",
                            onClick = {
                                val body = draft.draftBody()
                                reviewing = true
                                scope.launch {
                                    draft.previewError = checkRead({ repo!!.previewDraft(body) }) {
                                        draft.preview = it
                                        draft.previewedFor = body
                                    }
                                    reviewing = false
                                }
                            },
                            kind = LButtonKind.Primary,
                            enabled = repo != null && !reviewing && draft.goalReady && draft.stepsReady,
                        )
                    } else {
                        LButton(
                            "Save workflow",
                            onClick = {
                                val cid = s.containerId ?: return@LButton
                                controller.send(
                                    "Save workflow",
                                    WorkflowWrites.create(cid, draft.createBody(draft.preview?.previewDigest)),
                                    success = "Workflow saved",
                                ) { saved ->
                                    controller.discardDraft()
                                    onSaved(saved)
                                }
                            },
                            kind = LButtonKind.Primary,
                            enabled = !sending && controller.hasHuman,
                        )
                    }
                }
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard this draft?") },
            text = { Text("The steps, routes and repeat group you set here are removed. Nothing was saved to the server.") },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; controller.discardDraft(); onClose() }) { Text("Discard") }
            },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Keep draft") } },
        )
    }
}

@Composable
private fun GoalPage(draft: WorkflowCreateDraft, humanId: String?, humans: List<AgentDto>) {
    val p = Orcha.palette
    OutlinedTextField(draft.title, { draft.title = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
    Text(
        "Owner: " + (humans.firstOrNull { it.id == humanId }?.alias ?: "you"),
        style = ltype(LType.Meta), color = p.text2,
    )
    OutlinedTextField(draft.goal, { draft.goal = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Goal") }, minLines = 3)
    Text("How work runs", style = ltype(LType.BodyEmph), color = p.text)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(draft.mode == "serial", { draft.mode = "serial" }, label = { Text("Serial") })
        FilterChip(draft.mode == "parallel", { draft.mode = "parallel" }, label = { Text("Parallel") })
    }
    Text(
        if (draft.mode == "serial") "One task runs at a time, in order." else "Ready tasks can run at the same time.",
        style = ltype(LType.Meta), color = p.muted,
    )
    Text("Objectives (${draft.objectives.size}/50)", style = ltype(LType.BodyEmph), color = p.text)
    draft.objectives.forEachIndexed { i, o ->
        Card {
            OutlinedTextField(o.title, { draft.objectives[i] = o.copy(title = it.take(200)) }, Modifier.fillMaxWidth(), label = { Text("Title") })
            OutlinedTextField(o.criteria, { draft.objectives[i] = o.copy(criteria = it.take(4000)) }, Modifier.fillMaxWidth(), label = { Text("Done when") })
            LButton("Remove", onClick = { draft.objectives.removeAt(i) }, kind = LButtonKind.Ghost)
        }
    }
    if (draft.objectives.size < 50) {
        LButton("Add objective", onClick = { draft.objectives.add(WorkflowCreateDraft.Objective()) })
    }
}

@Composable
private fun StepsPage(draft: WorkflowCreateDraft, workers: List<AgentDto>, humans: List<AgentDto>) {
    val p = Orcha.palette
    Text(
        "Steps (${draft.steps.size}/200). The graph view is read-only on the phone; draw on the laptop.",
        style = ltype(LType.Meta), color = p.muted,
    )
    draft.steps.forEachIndexed { i, step ->
        StepCard(draft, i, step, workers)
    }
    if (draft.steps.size < 200) LButton("Add step", onClick = { draft.steps.add(draft.newStep()) })
    RepeatGroupCard(draft, humans)
}

@Composable
private fun StepCard(draft: WorkflowCreateDraft, index: Int, step: Step, workers: List<AgentDto>) {
    val p = Orcha.palette
    var showInstructions by remember { mutableStateOf(step.description.isNotEmpty()) }
    var newOutcome by remember { mutableStateOf("") }
    fun update(s: Step) { draft.steps[index] = s }
    val dependents = draft.dependents(step.clientKey)
    Card {
        Text("Draft · Autonomy OFF", style = ltype(LType.Micro), color = p.muted)
        OutlinedTextField(step.title, { update(step.copy(title = it.take(200))) }, Modifier.fillMaxWidth(), label = { Text("Step ${index + 1}") })
        OutlinedTextField(step.done, { update(step.copy(done = it.take(4000))) }, Modifier.fillMaxWidth(), label = { Text("Done when") }, minLines = 2)
        AgentPicker("Assignee", workers, step.assigneeId, allowKeep = true) { update(step.copy(assigneeId = it)) }
        Text("The agent asks you to approve its plan and its finished work before anything counts.", style = ltype(LType.Meta), color = p.muted)

        Text("Depends on", style = ltype(LType.BodyEmph), color = p.text)
        draft.steps.filter { it.clientKey != step.clientKey }.forEach { other ->
            val chosen = other.clientKey in step.dependsOn
            val reason = when {
                chosen -> null
                step.dependsOn.size >= 3 -> "At most 3 prerequisites"
                dependsOnTransitively(draft, other.clientKey, step.clientKey) -> "Would create a cycle"
                else -> null
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(enabled = reason == null) {
                update(step.copy(dependsOn = if (chosen) step.dependsOn - other.clientKey else step.dependsOn + other.clientKey))
            }) {
                Checkbox(chosen, null, enabled = reason == null)
                Column {
                    Text(other.title.ifBlank { "Untitled step" }, color = if (reason == null) p.text else p.muted)
                    reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
                }
            }
        }

        Text(if (showInstructions) "Hide instructions" else "Instructions…", color = p.accent, modifier = Modifier.clickable { showInstructions = !showInstructions })
        if (showInstructions) {
            OutlinedTextField(step.description, { update(step.copy(description = it.take(4000))) }, Modifier.fillMaxWidth(), label = { Text("Instructions") }, minLines = 2)
        }

        Text("Outcomes this step can report", style = ltype(LType.BodyEmph), color = p.text)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (OUTCOME_SUGGESTIONS + step.outcomes.filter { it !in OUTCOME_SUGGESTIONS }).forEach { o ->
                val on = o in step.outcomes
                FilterChip(on, {
                    update(
                        if (on) step.copy(outcomes = step.outcomes - o, routes = step.routes.filterNot { it.outcome == o })
                        else if (step.outcomes.size < 8) step.copy(outcomes = step.outcomes + o, routes = step.routes + WorkflowCreateDraft.Route(o))
                        else step,
                    )
                }, label = { Text(o) })
            }
        }
        if (step.outcomes.size < 8) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(newOutcome, { newOutcome = it.take(40) }, Modifier.weight(1f), label = { Text("Other outcome") }, singleLine = true)
                LButton("Add", onClick = {
                    val o = newOutcome.trim()
                    if (o.isNotEmpty() && o !in step.outcomes) update(step.copy(outcomes = step.outcomes + o, routes = step.routes + WorkflowCreateDraft.Route(o)))
                    newOutcome = ""
                }, kind = LButtonKind.Ghost)
            }
        }
        if (step.outcomes.isNotEmpty()) {
            Text("What happens next", style = ltype(LType.BodyEmph), color = p.text)
            step.routes.forEachIndexed { ri, route ->
                RouteRow(draft, step, route) { r -> update(step.copy(routes = step.routes.toMutableList().also { it[ri] = r })) }
            }
        }
        LButton(
            if (dependents.isEmpty()) "Remove step" else "Change dependents first",
            onClick = {
                draft.steps.removeAt(index)
                draft.group = draft.group?.let { g ->
                    g.copy(members = g.members - step.clientKey, reviewTask = g.reviewTask?.takeIf { it != step.clientKey })
                }
            },
            kind = LButtonKind.Ghost,
            enabled = dependents.isEmpty() && draft.steps.size > 1,
        )
    }
}

@Composable
private fun RouteRow(draft: WorkflowCreateDraft, step: Step, route: WorkflowCreateDraft.Route, onChange: (WorkflowCreateDraft.Route) -> Unit) {
    val p = Orcha.palette
    var open by remember { mutableStateOf(false) }
    val label = DESTINATIONS.firstOrNull { it.first == route.destination }?.second.orEmpty() +
        (route.destinationTask?.takeIf { route.destination == "step" }?.let { k -> ": " + (draft.steps.firstOrNull { it.clientKey == k }?.title ?: "?") } ?: "")
    Column {
        Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp)) {
            Text(route.outcome, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
            Text("→ $label", color = p.text2)
        }
        if (open) {
            DESTINATIONS.forEach { (key, text) ->
                if (key == "step") {
                    draft.steps.filter { it.clientKey != step.clientKey }.forEach { target ->
                        DestinationOption("Go to: ${target.title.ifBlank { "Untitled step" }}", route.destination == key && route.destinationTask == target.clientKey) {
                            onChange(route.copy(destination = key, destinationTask = target.clientKey)); open = false
                        }
                    }
                } else {
                    DestinationOption(text, route.destination == key) { onChange(route.copy(destination = key, destinationTask = null)); open = false }
                }
            }
        }
    }
}

@Composable
private fun DestinationOption(text: String, selected: Boolean, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        RadioButton(selected, onClick)
        Text(text, color = Orcha.palette.text)
    }
}

@Composable
private fun RepeatGroupCard(draft: WorkflowCreateDraft, humans: List<AgentDto>) {
    val p = Orcha.palette
    val g = draft.group
    if (g == null) {
        LButton("Add repeat group", onClick = { draft.group = WorkflowCreateDraft.Group() }, enabled = draft.steps.size >= 2)
        return
    }
    Card {
        Text("Repeat group", style = ltype(LType.BodyEmph), color = p.text)
        OutlinedTextField(g.name, { draft.group = g.copy(name = it.take(80)) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
        Text("Steps in the group (2–10)", style = ltype(LType.Meta), color = p.text2)
        draft.steps.forEach { st ->
            val on = st.clientKey in g.members
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable {
                draft.group = if (on) g.copy(members = g.members - st.clientKey, reviewTask = g.reviewTask?.takeIf { it != st.clientKey })
                else if (g.members.size < 10) g.copy(members = g.members + st.clientKey) else g
            }) {
                Checkbox(on, null)
                Text(st.title.ifBlank { "Untitled step" }, color = p.text)
            }
        }
        Text("Review step", style = ltype(LType.Meta), color = p.text2)
        draft.steps.filter { it.clientKey in g.members }.forEach { st ->
            DestinationOption(st.title.ifBlank { "Untitled step" }, g.reviewTask == st.clientKey) {
                draft.group = g.copy(reviewTask = st.clientKey, exitOutcome = st.outcomes.firstOrNull() ?: "")
            }
        }
        val reviewOutcomes = draft.steps.firstOrNull { it.clientKey == g.reviewTask }?.outcomes.orEmpty()
        Text("Exit when the review step reports", style = ltype(LType.Meta), color = p.text2)
        if (reviewOutcomes.isEmpty()) Text("Give the review step an outcome first.", style = ltype(LType.Meta), color = p.muted)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            reviewOutcomes.forEach { o -> FilterChip(g.exitOutcome == o, { draft.group = g.copy(exitOutcome = o) }, label = { Text(o) }) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Most rounds: ${g.maxRounds}", color = p.text, modifier = Modifier.weight(1f))
            LButton("−", onClick = { draft.group = g.copy(maxRounds = (g.maxRounds - 1).coerceAtLeast(1)) }, kind = LButtonKind.Ghost)
            LButton("+", onClick = { draft.group = g.copy(maxRounds = (g.maxRounds + 1).coerceAtMost(20)) }, kind = LButtonKind.Ghost)
        }
        Text("At the limit, the owner decides what happens next.", style = ltype(LType.Meta), color = p.muted)
        Text("Escalation owner", style = ltype(LType.Meta), color = p.text2)
        DestinationOption("Workflow owner", g.escalationOwnerId == null) { draft.group = g.copy(escalationOwnerId = null) }
        humans.forEach { h -> DestinationOption(h.alias, g.escalationOwnerId == h.id) { draft.group = g.copy(escalationOwnerId = h.id) } }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable {
            draft.group = g.copy(stallRule = if (g.stallRule == "off") "findings_and_artifact" else "off")
        }) {
            Checkbox(g.stallRule != "off", null)
            Text("Stop early when a round repeats the same findings and result", color = p.text)
        }
        LButton("Remove repeat group", onClick = { draft.group = null }, kind = LButtonKind.Ghost)
    }
}

@Composable
private fun ReviewPage(draft: WorkflowCreateDraft) {
    val p = Orcha.palette
    val preview = draft.preview?.takeIf { draft.previewedFor == draft.draftBody() }
    draft.previewError?.let { Banner(BannerKind.Danger, it) }
    if (preview == null) {
        Text("Review the draft to check it with the server before saving.", color = p.text2)
        Text("${draft.steps.size} steps · ${draft.objectives.size} objectives" + (draft.group?.let { " · repeat group \"${it.name}\"" } ?: ""), style = ltype(LType.Meta), color = p.muted)
        return
    }
    if (preview.blockers.isNotEmpty()) {
        Text("Fix these before saving", style = ltype(LType.BodyEmph), color = p.text)
        preview.blockers.forEach { Text("• ${it.message}", color = p.text2) }
        return
    }
    Card {
        Text("Ready to save", style = ltype(LType.BodyEmph), color = p.text)
        Text("${draft.title.trim()} · ${draft.steps.size} steps", color = p.text2)
        Text(
            if (preview.saveStartsWork) "Saving will start work." else "Saving does not start work. Tasks start after you review Start.",
            style = ltype(LType.Meta), color = p.muted,
        )
        Text("Each agent gets up to 40 turns by default.", style = ltype(LType.Meta), color = p.muted)
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    val p = Orcha.palette
    Column(
        Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/** True when [from] already (transitively) depends on [target]; adding target→from would loop. */
private fun dependsOnTransitively(draft: WorkflowCreateDraft, from: String, target: String): Boolean {
    val byKey = draft.steps.associateBy { it.clientKey }
    val seen = mutableSetOf<String>()
    val stack = ArrayDeque(listOf(from))
    while (stack.isNotEmpty()) {
        val k = stack.removeLast()
        if (k == target) return true
        if (seen.add(k)) byKey[k]?.dependsOn?.let { stack.addAll(it) }
    }
    return false
}
