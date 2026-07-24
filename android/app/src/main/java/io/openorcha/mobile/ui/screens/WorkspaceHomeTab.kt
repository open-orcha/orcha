package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.OkTonalButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.RequestStatusPill
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.StatTile
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* Home tab (flow 04 H5): needs-you queue → agents glance → stat tiles → activity feed. */

@Composable
internal fun HomeTab(
    state: OrchaUiState,
    planApprovals: List<TaskDto>,
    verifications: List<TaskDto>,
    requestsForMe: List<RequestDto>,
    onOpenTask: (String) -> Unit,
    onOpenRequest: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    onTab: (WorkspaceTab) -> Unit,
    onPlanSheet: (TaskDto) -> Unit,
    onVerifySheet: (TaskDto) -> Unit,
) {
    val snapshot = state.snapshot ?: return
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { SectionH("Needs you", "${planApprovals.size + verifications.size + requestsForMe.size}") }
        if (planApprovals.isEmpty() && verifications.isEmpty() && requestsForMe.isEmpty()) {
            item { OrchaCard { Text("Nothing needs you right now.", color = p.muted) } }
        }
        items(planApprovals, key = { "plan-${it.id}" }) { task ->
            OrchaCard(onClick = { onOpenTask(task.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("PLAN APPROVAL", style = MaterialTheme.typography.labelMedium, color = p.violet)
                    Spacer(Modifier.weight(1f))
                    StatusPill(task.status, StatusDomain.Task)
                }
                Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                task.planMessage?.let { pm ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Avatar(pm.authorAlias ?: "?", human = false, size = AvatarSize.Sm)
                        Text("${pm.authorAlias ?: "agent"} proposes a plan", style = MaterialTheme.typography.bodyMedium, color = p.text2)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Approve plan", { onPlanSheet(task) }, Modifier.weight(1f), small = true)
                    DangerTonalButton("Reject…", { onPlanSheet(task) }, Modifier.weight(1f), small = true)
                }
            }
        }
        items(verifications, key = { "verify-${it.id}" }) { task ->
            OrchaCard(onClick = { onOpenTask(task.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("VERIFY TASK", style = MaterialTheme.typography.labelMedium, color = p.ok)
                    Spacer(Modifier.weight(1f))
                    StatusPill(task.status, StatusDomain.Task)
                }
                Text(task.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                task.definitionOfDone?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OkTonalButton("Accept", { onVerifySheet(task) }, Modifier.weight(1f), small = true)
                    DangerTonalButton("Reject…", { onVerifySheet(task) }, Modifier.weight(1f), small = true)
                }
            }
        }
        items(requestsForMe, key = { "req-${it.id}" }) { req ->
            // server rows never carry requester_alias — resolve from snapshot.agents (web data.js parity)
            val fromAlias = RequestsView.aliasFor(snapshot.agents, req.requesterId) ?: req.requesterAlias
            OrchaCard(onClick = { onOpenRequest(req.id) }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("REQUEST FOR YOU", style = MaterialTheme.typography.labelMedium, color = p.info)
                    Spacer(Modifier.weight(1f))
                    RequestStatusPill(req.status, escalated = RequestsView.isEscalatedOpen(req, snapshot.agents))
                }
                Text("“${req.payload}”", style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Avatar(fromAlias ?: "?", human = RequestsView.kindFor(snapshot.agents, req.requesterId) == "human", size = AvatarSize.Sm)
                    Text(
                        "${fromAlias ?: "agent"} → you${MobileUx.agoLabel(req.createdAt)?.let { " · $it" } ?: ""}",
                        style = MaterialTheme.typography.bodyMedium, color = p.text2,
                    )
                    Spacer(Modifier.weight(1f))
                    PrimaryButton("Respond", { onOpenRequest(req.id) }, small = true)
                }
            }
        }

        item { SectionH("Agents", "${snapshot.agents.size}") }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(MobileUx.orderAgents(snapshot.agents.filter { it.kind == "ai" }), key = { it.id }) { agent ->
                    OrchaCard(Modifier.width(176.dp), onClick = { onOpenAgent(agent.id) }) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Avatar(agent.alias, human = false, size = AvatarSize.Sm)
                            Column {
                                Text(agent.alias, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                                StatusPill(agent.status ?: "idle", StatusDomain.Agent)
                            }
                        }
                    }
                }
            }
        }

        item { SectionH("Tasks") }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "in_progress")}", "In progress", p.accent, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "needs_verification")}", "Needs verify", p.violet, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "blocked")}", "Blocked", p.warn, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
                StatTile("${OrchaSelectors.statusCount(snapshot.tasks, "completed")}", "Done", p.ok, Modifier.weight(1f)) { onTab(WorkspaceTab.Tasks) }
            }
        }

        val activity = snapshot.tasks
            .mapNotNull { t -> t.messageSummary?.last?.let { m -> t to m } }
            .sortedByDescending { it.second.createdAt ?: "" }
            .take(8)
        if (activity.isNotEmpty()) {
            item { SectionH("Activity") }
            items(activity, key = { "act-${it.first.id}-${it.second.messageId ?: it.second.createdAt}" }) { (task, msg) ->
                OrchaCard(onClick = { onOpenTask(task.id) }) {
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(msg.authorAlias ?: if (msg.isHuman) "H" else "?", human = msg.isHuman, size = AvatarSize.Sm)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row {
                                Text(msg.authorAlias ?: if (msg.isHuman) "you" else "system", style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.weight(1f))
                                Text(MobileUx.agoLabel(msg.createdAt) ?: "", style = MonoSmStyle, color = p.faint)
                            }
                            Text(msg.body, style = MaterialTheme.typography.bodyMedium, color = p.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
        state.error?.let { item { Banner(BannerKind.Danger, it) } }
        item { Spacer(Modifier.height(72.dp)) } // FAB clearance
    }
}
