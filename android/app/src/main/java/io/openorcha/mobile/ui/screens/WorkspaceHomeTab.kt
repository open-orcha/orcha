package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LPriorityGlyph
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Home tab, Linear-style (iOS HomeTabView parity): a calm project header (name,
   objective, one-line task tally, agent stack, repo chip), then "Needs you",
   "Active work" and an "Updates" feed as hairline rows under muted captions. */

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
    onOpenGithubHub: () -> Unit = {},
    /** Opens Metrics & usage (the usage card under the header). */
    onOpenMetrics: () -> Unit = {},
) {
    val snapshot = state.snapshot ?: return
    val needsCount = planApprovals.size + verifications.size + requestsForMe.size
    val active = homeActiveWork(snapshot.tasks)
    val activity = snapshot.tasks
        .mapNotNull { t -> t.messageSummary?.last?.let { m -> t to m } }
        .sortedByDescending { it.second.createdAt ?: "" }
        .take(8)

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
        verticalArrangement = Arrangement.spacedBy(LSpace.xl),
    ) {
        item(key = "home-header") {
            // Unbound: "Connect repo" opens the Connect-repository sheet (iOS parity); bound: the GitHub hub.
            var connectRepo by remember { mutableStateOf(false) }
            val repo = InboxRepoBinding.bound(snapshot.container.id, snapshot.container.githubRepo)
            HomeHeader(
                snapshot.copy(container = snapshot.container.copy(githubRepo = repo)),
                onOpenAgent = onOpenAgent, onAgents = { onTab(WorkspaceTab.Agents) },
                onRepo = { if (repo == null && state.selectedContainer != null) connectRepo = true else onOpenGithubHub() },
            )
            if (connectRepo) InboxConnectRepoHost(state, onDismiss = { connectRepo = false })
            // Plan usage (Claude / Codex limits from the desktop) in place of "This week".
            // Hidden unless the portal-wide "Show plan usage" setting is on (default off).
            val planUsageUrls = state.containers.map { it.baseUrl }
            val planUsage = rememberPlanUsage(planUsageUrls)
            var showPlanUsage by remember { mutableStateOf(false) }
            if (showPlanUsage) PlanUsageSheet(planUsage, planUsageUrls, onDismiss = { showPlanUsage = false })
            if (PlanUsageDisplayStore.display.show) {
                Spacer(Modifier.height(LSpace.m))
                PlanUsageCard(planUsage, onOpen = { showPlanUsage = true })
            }
            HomeObjectiveEditor(state)
        }

        item(key = "home-needs") {
            LSection("Needs you", count = needsCount) {
                if (needsCount == 0) {
                    HomeQuietRow("Nothing needs you right now.")
                } else Column {
                    planApprovals.forEach { task ->
                        NeedsYouTaskRow(task, kind = "Plan", tint = Orcha.palette.warn) { onPlanSheet(task) }
                    }
                    verifications.forEach { task ->
                        NeedsYouTaskRow(task, kind = "Verify", tint = Orcha.palette.ok) { onVerifySheet(task) }
                    }
                    requestsForMe.forEach { req ->
                        NeedsYouRequestRow(req, snapshot.agents) { onOpenRequest(req.id) }
                    }
                }
            }
        }

        item(key = "home-active") {
            LSection("Active work", count = active.size) {
                if (active.isEmpty()) {
                    HomeQuietRow("No tasks in flight.")
                } else Column {
                    active.forEach { task -> ActiveTaskRow(task) { onOpenTask(task.id) } }
                }
            }
        }

        if (activity.isNotEmpty()) {
            item(key = "home-updates") {
                LSection("Updates", count = activity.size) {
                    Column { activity.forEach { (task, msg) -> UpdateRow(task, msg) { onOpenTask(task.id) } } }
                }
            }
        }

        state.error?.let { err -> item(key = "home-error") { Banner(BannerKind.Danger, err) } }
        item(key = "home-bottom") { Spacer(Modifier.height(LSpace.l)) }
    }
}

/** In-flight tasks for "Active work": in progress → blocked → ready, then by priority. */
internal fun homeActiveWork(tasks: List<TaskDto>): List<TaskDto> = tasks
    .filter { it.status in setOf("in_progress", "blocked", "ready") }
    .sortedWith(compareBy<TaskDto> { MobileUx.taskGroupRank(it.status) }.thenBy { it.priority ?: 100 })
    .take(8)

/** "5 in progress · 2 to verify · 0 blocked · 2 done" — the header's one-line tally.
 *  "done" counts the same set as the Tasks tab's Done pill ([TaskScope.Done]). */
internal fun homeTally(tasks: List<TaskDto>): String {
    fun n(s: String) = OrchaSelectors.statusCount(tasks, s)
    return "${n("in_progress")} in progress · ${n("needs_verification")} to verify · " +
        "${n("blocked")} blocked · ${tasks.count { TaskScope.of(it.status) == TaskScope.Done }} done"
}

// ---------------------------------------------------------------------------- header

@Composable
private fun HomeHeader(
    snapshot: ContainerSnapshot,
    onOpenAgent: (String) -> Unit,
    onAgents: () -> Unit,
    onRepo: () -> Unit,
) {
    val p = Orcha.palette
    val aiAgents = MobileUx.orderAgents(snapshot.agents.filter { it.kind == "ai" })
    Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
        Text(
            snapshot.container.name,
            style = ltype(LType.Title),
            color = p.text,
            modifier = Modifier.semantics { heading() },
        )
        snapshot.container.description?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = ltype(LType.Body), color = p.text2, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Text(homeTally(snapshot.tasks), style = ltype(LType.Meta), color = p.muted)
        Row(
            Modifier.padding(top = LSpace.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            if (aiAgents.isNotEmpty()) {
                AgentStack(aiAgents, onClick = if (aiAgents.size == 1) ({ onOpenAgent(aiAgents.first().id) }) else onAgents)
            }
            RepoChip(snapshot.container.githubRepo, onRepo)
        }
    }
}

/** Overlapping round avatars of the project's agents — read as one element. */
@Composable
private fun AgentStack(agents: List<AgentDto>, onClick: () -> Unit) {
    val p = Orcha.palette
    val shown = agents.take(5)
    Row(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "${agents.size} agents: ${shown.joinToString(", ") { it.alias }}"
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        shown.forEachIndexed { i, agent ->
            Box(
                Modifier
                    .offset(x = (-6 * i).dp)
                    .background(p.bg, CircleShape)
                    .padding(1.5.dp),
            ) {
                // Plain faces: in an overlapping stack the ✦ badge and presence dot sit
                // under the next avatar and render as clipped fragments (same fix as iOS).
                LAvatar(agent.alias, size = 24.dp)
            }
        }
        if (agents.size > 5) {
            Box(
                Modifier
                    .offset(x = (-6 * shown.size).dp)
                    .size(27.dp)
                    .background(p.surface2, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("+${agents.size - 5}", style = ltype(LType.Micro), color = p.text2)
            }
        }
    }
}

/** "Connect repo" (unbound) or the bound "owner/name" chip — both open the GitHub hub,
 *  which shows its own connect-a-repo state when nothing is bound. */
@Composable
private fun RepoChip(repo: String?, onClick: () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(8.dp)
    val bound = repo != null
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = if (bound) "Open GitHub hub" else "Connect a repo", onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .background(if (bound) p.surface else p.accentSoft, shape)
                .border(1.dp, if (bound) p.border else p.accentLine, shape)
                .padding(horizontal = LSpace.s, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(OrchaIcons.GitHub, null, tint = if (bound) p.text2 else p.accent, modifier = Modifier.size(14.dp))
            Text(
                repo ?: "Connect repo",
                style = ltype(if (bound) LType.Mono else LType.Meta),
                color = if (bound) p.text2 else p.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ---------------------------------------------------------------------------- rows

@Composable
private fun HomeQuietRow(text: String) {
    Text(
        text,
        style = ltype(LType.Body),
        color = Orcha.palette.muted,
        modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = LSpace.m, vertical = LSpace.m),
    )
}

@Composable
private fun TrailingMeta(tag: String, tint: androidx.compose.ui.graphics.Color, iso: String?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
        LTag(tag, tint = tint, dot = true)
        MobileUx.agoLabel(iso)?.let { Text(it, style = ltype(LType.Meta), color = Orcha.palette.muted, maxLines = 1) }
    }
}

@Composable
private fun NeedsYouTaskRow(task: TaskDto, kind: String, tint: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    LRow(
        title = task.title,
        onClick = onClick,
        leading = { LStatusGlyph(task.status) },
        trailing = { TrailingMeta(kind, tint, task.planMessage?.createdAt ?: task.startedAt ?: task.createdAt) },
    )
}

@Composable
private fun NeedsYouRequestRow(req: RequestDto, agents: List<AgentDto>, onClick: () -> Unit) {
    // Server rows never carry requester_alias — resolve from the roster (web data.js parity).
    val from = RequestsView.aliasFor(agents, req.requesterId) ?: req.requesterAlias ?: "agent"
    val isHuman = RequestsView.kindFor(agents, req.requesterId) == "human"
    LRow(
        title = req.payload,
        subtitle = "$from → you",
        onClick = onClick,
        leading = { LAvatar(from, isAI = !isHuman, size = 20.dp) },
        trailing = { TrailingMeta("Request", Orcha.palette.danger, req.createdAt) },
    )
}

@Composable
private fun ActiveTaskRow(task: TaskDto, onClick: () -> Unit) {
    val p = Orcha.palette
    LRow(
        title = task.title,
        onClick = onClick,
        leading = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                LPriorityGlyph(task.priority)
                Text(task.shortId, style = ltype(LType.Mono), color = p.muted)
                LStatusGlyph(task.status)
            }
        },
        trailing = task.assignees.firstOrNull()?.let { a -> { LAvatar(a, isAI = true, size = 20.dp) } },
    )
}

@Composable
private fun UpdateRow(task: TaskDto, msg: TaskMessageDto, onClick: () -> Unit) {
    val p = Orcha.palette
    val actor = msg.authorAlias ?: if (msg.isHuman) "you" else "system"
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(horizontal = LSpace.m, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        LAvatar(actor, isAI = !msg.isHuman, size = 24.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.xs)) {
                Text(actor, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1)
                Text(
                    "on ${task.title}",
                    style = ltype(LType.Body),
                    color = p.text2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(MobileUx.agoLabel(msg.createdAt) ?: "", style = ltype(LType.Meta), color = p.muted, maxLines = 1)
            }
            Text(ActivityCopy.preview(msg.body), style = ltype(LType.Meta), color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
