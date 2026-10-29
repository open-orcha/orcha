package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowNewTaskBody
import io.openorcha.mobile.data.WorkflowWrites
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.domain.WorkflowLogic.NewTaskDraft
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W11 Add new tasks: the W10 step cards in a sheet (web WorkflowAddTasks.tsx). Outcome routes and
   repeat groups stay create-only (design §1 principle 5), so cards carry summary, done when,
   assignee, prerequisites and instructions. One atomic POST /api/workflows/{wid}/tasks. */
@Composable
internal fun WorkflowAddTasksSheet(
    controller: WorkflowsController,
    detail: WorkflowDetailDto,
    snapshot: ContainerSnapshot,
    onClose: () -> Unit,
) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val d = s.detail ?: detail
    val repo = controller.repository ?: return
    val agents = snapshot.agents.filter { it.kind != "human" }
    var drafts by remember { mutableStateOf(listOf(NewTaskDraft("n1"))) }
    var nextKey by remember { mutableIntStateOf(2) }
    val existing = d.tasks.filter { it.withdrawnAt == null }
    val problem = WorkflowLogic.addTasksProblem(drafts, existing.map { it.id })
    val serverReason = WorkflowLogic.actionReason(d, "add_tasks", controller.hasHuman)
    fun titleOf(id: String) = drafts.firstOrNull { it.key == id }?.title?.ifBlank { null }
        ?: existing.firstOrNull { it.id == id }?.title ?: "unavailable prerequisite"

    WorkflowActionSheet(
        controller = controller,
        title = "Add new tasks",
        description = "New tasks start with autonomy OFF. They are saved as drafts, with start holds. " +
            if (d.launchEnabled) "This Workflow has already started, so preparing a new task after saving also releases its start hold and it can begin once it is eligible."
            else "Prepare and release them explicitly after saving.",
        confirmLabel = "Confirm task addition",
        onClose = onClose,
        check = {
            checkRead({ repo.detail(d.id) }) { controller.applyDetail(it) }
                ?: (controller.state.value.detail ?: d).let { latest ->
                    WorkflowLogic.actionReason(latest, "add_tasks", controller.hasHuman)
                        ?: WorkflowLogic.addTasksProblem(drafts, latest.tasks.filter { it.withdrawnAt == null }.map { it.id })
                }
        },
        checkedNote = "Checked against revision ${d.revision}.",
        confirmEnabled = serverReason == null && problem == null,
        disabledHint = serverReason ?: problem,
        write = { key ->
            WorkflowWrites.addTasks(
                d, key,
                drafts.map { t ->
                    WorkflowNewTaskBody(
                        clientKey = t.key, title = t.title.trim(),
                        description = t.description.trim(), definitionOfDone = t.done.trim(),
                        assigneeId = t.assigneeId, priority = 100, dependsOn = t.dependsOn,
                    )
                },
            )
        },
    ) {
        drafts.forEachIndexed { index, task ->
            fun update(t: NewTaskDraft) { drafts = drafts.toMutableList().also { it[index] = t } }
            val dependents = drafts.filter { task.key in it.dependsOn }
            Text("Draft · Autonomy OFF", style = ltype(LType.Micro), color = p.muted)
            OutlinedTextField(task.title, { update(task.copy(title = it.take(200))) }, Modifier.fillMaxWidth(), label = { Text("New task ${index + 1}") })
            OutlinedTextField(task.done, { update(task.copy(done = it.take(4000))) }, Modifier.fillMaxWidth(), label = { Text("Done when") }, minLines = 2)
            AgentPicker("Assignee", agents, task.assigneeId, allowKeep = true) { update(task.copy(assigneeId = it)) }
            Text("Depends on", style = ltype(LType.BodyEmph), color = p.text)
            (existing.map { it.id to it.title } + drafts.filter { it.key != task.key }.map { it.key to it.title.ifBlank { "Untitled task" } })
                .forEach { (id, title) ->
                    val chosen = id in task.dependsOn
                    val reason = WorkflowLogic.addTaskDependencyReason(drafts, task, id)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable(enabled = reason == null) {
                            update(task.copy(dependsOn = if (chosen) task.dependsOn - id else task.dependsOn + id))
                        },
                    ) {
                        Checkbox(chosen, null, enabled = reason == null)
                        Column {
                            Text(title, color = if (reason == null) p.text else p.muted)
                            reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
                        }
                    }
                }
            OutlinedTextField(task.description, { update(task.copy(description = it.take(4000))) }, Modifier.fillMaxWidth(), label = { Text("Instructions (optional)") }, minLines = 2)
            Text(
                if (dependents.isEmpty()) "Remove new task ${index + 1}" else "Change dependents first",
                color = if (dependents.isEmpty()) p.accent else p.muted,
                modifier = Modifier.clickable(enabled = dependents.isEmpty()) { drafts = drafts - task },
            )
        }
        if (drafts.size < 200) {
            Text(
                "Add task summary", color = p.accent,
                modifier = Modifier.fillMaxWidth().clickable { drafts = drafts + NewTaskDraft("n$nextKey"); nextKey += 1 },
            )
        }
        if (drafts.isNotEmpty()) {
            Text(
                "${WorkflowLogic.plural(drafts.size, "new task")} will join this workflow atomically. Existing progress may decrease as scope grows; goal acceptance will need review.",
                style = ltype(LType.Meta), color = p.text2,
            )
            drafts.forEach { t ->
                val who = agents.firstOrNull { it.id == t.assigneeId }?.alias ?: "Choose assignee later"
                val after = if (t.dependsOn.isEmpty()) "No prerequisites." else "Starts after ${t.dependsOn.joinToString(", ") { titleOf(it) }} is accepted."
                Text("• ${t.title.ifBlank { "Untitled task" }} — Draft · Autonomy OFF · Start hold · $who. $after", style = ltype(LType.Meta), color = p.text2)
            }
        }
    }
}
