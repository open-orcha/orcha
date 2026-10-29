package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha

/* W19 Needs your input (inside the workflow): plan approvals, finished work and owner
   decisions for this workflow's tasks. Workflow-scoped questions are a proposed API (request
   reads carry no task link, design §7 ask 2), so the list says so and links to Requests. */

internal enum class InputKind(val label: String) { Plan("Plan approval"), Finished("Finished work"), Decision("Owner decision") }

internal data class InputItem(
    val kind: InputKind,
    val taskId: String,
    val title: String,
    /** Who the decision belongs to; null = anyone with permission. */
    val intendedId: String?,
    val requester: String?,
    val age: String,
) {
    fun sheet(d: WorkflowDetailDto): WorkflowSheet = when (kind) {
        InputKind.Plan -> WorkflowSheet.Plan(taskId)
        InputKind.Finished -> WorkflowSheet.ResultReview(taskId)
        InputKind.Decision -> WorkflowSheet.Decision(taskId)
    }
}

/** Items for the strip, in the web order: owner decisions, finished work, then plan approvals. */
internal fun workflowInputItems(d: WorkflowDetailDto, snapshot: ContainerSnapshot, actorId: String?): List<InputItem> {
    val snapTask = { id: String -> snapshot.tasks.firstOrNull { it.id == id } }
    val decisions = d.tasks.filter { it.awaitingLoopDecision != null }.map {
        InputItem(InputKind.Decision, it.id, it.title, d.ownerHumanId, null, "")
    }
    val finished = d.tasks.filter { it.status == "needs_verification" && it.withdrawnAt == null }.map {
        val st = snapTask(it.id)
        InputItem(InputKind.Finished, it.id, it.title, null, st?.assignees?.firstOrNull(), relativeAge(st?.completedAt ?: st?.startedAt))
    }
    val plans = d.tasks.filter { t ->
        t.autonomy == "off" && snapTask(t.id)?.let { isPlanWaiting(it) } == true
    }.map {
        val st = snapTask(it.id)
        InputItem(InputKind.Plan, it.id, it.title, null, st?.assignees?.firstOrNull(), relativeAge(st?.startedAt))
    }
    return decisions + finished + plans
}

internal fun workflowInputList(
    scope: LazyListScope,
    items: List<InputItem>,
    d: WorkflowDetailDto,
    onOpen: (InputItem) -> Unit,
    onOpenRequests: () -> Unit,
) {
    scope.item(key = "input-head") {
        val p = Orcha.palette
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${items.size} need your input", style = ltype(LType.Headline), color = p.text)
            Text(
                "Workflow questions are not available on this server. Questions stay in the Requests tab.",
                style = ltype(LType.Meta), color = p.muted,
            )
        }
    }
    scope.items(items, key = { "in:${it.kind}:${it.taskId}" }) { item ->
        val p = Orcha.palette
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
                .background(p.surface, RoundedCornerShape(p.radiusCard.dp))
                .clickable { onOpen(item) }
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LTag(item.kind.label)
            Column(Modifier.weight(1f)) {
                Text(item.title, style = ltype(LType.Body), color = p.text)
                val who = listOfNotNull(item.requester?.let { "from $it" }, item.age.takeIf { it.isNotEmpty() }).joinToString(" · ")
                if (who.isNotEmpty()) Text(who, style = ltype(LType.Meta), color = p.text2)
            }
        }
    }
}
