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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.CommentExpansion
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.WorkspaceTab
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.ExpandableCommentText
import io.openorcha.mobile.ui.components.ExpandableText
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
import kotlinx.coroutines.launch

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
    /** W17: workflows waiting on an owner decision (limit reached, stalled, missing outcome, ask owner). */
    ownerDecisions: List<io.openorcha.mobile.data.WorkflowDetailDto> = emptyList(),
    onOpenWorkflow: (String) -> Unit = {},
    /** GH #378: a task's newest comment in full (Home's Updates only carry its first 140 characters); null on failure. */
    loadNewestComment: suspend (taskId: String) -> TaskMessageDto? = { null },
) {
    val snapshot = state.snapshot ?: return
    val decisions = ownerDecisions.mapNotNull { w -> io.openorcha.mobile.domain.WorkflowLogic.ownerBar(w)?.let { w to it } }
    val needsCount = planApprovals.size + verifications.size + requestsForMe.size + decisions.size
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
                    decisions.forEach { (w, bar) ->
                        LRow(
                            title = bar.second,
                            subtitle = w.title,
                            onClick = { onOpenWorkflow(w.id) },
                            leading = { LStatusGlyph("blocked") },
                            trailing = { TrailingMeta("Decide", Orcha.palette.warn, null) },
                        )
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
                    Column { activity.forEach { (task, msg) ->
                        // A newer comment on the task starts a fresh row (collapsed, nothing fetched).
                        key(task.id, msg.createdAt) { UpdateRow(task, msg, loadNewestComment) { onOpenTask(task.id) } }
                    } }
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
            ExpandableText(it, style = ltype(LType.Body), color = p.text2, collapsedLines = 3)
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

/**
 * Updates feed row: avatar, actor + action, time and a 2-line preview of the task's latest comment; the row
 * opens the task and Show more is its own button. The task list sends only the first 140 characters of that
 * comment, so Show more fetches the complete comment before expanding (GH #378 QA round 1).
 */
@Composable
private fun UpdateRow(task: TaskDto, msg: TaskMessageDto, loadNewestComment: suspend (String) -> TaskMessageDto?, onClick: () -> Unit) {
    val p = Orcha.palette
    val actor = msg.authorAlias ?: if (msg.isHuman) "you" else "system"
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable { mutableStateOf(false) }
    var complete by rememberSaveable { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var loadFailed by remember { mutableStateOf(false) }
    val shown = complete ?: msg.body
    val cut = complete == null && CommentExpansion.summaryMayBeCut(msg.body)
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
            UpdateHeader(actor, task.title, MobileUx.agoLabel(msg.createdAt) ?: "")
            // The toggle is its own clickable, so TalkBack reads it as a separate button and its tap never opens the task.
            ExpandableCommentText(
                text = AnnotatedString(
                    if (expanded) ActivityCopy.humanize(shown)
                    else ActivityCopy.preview(shown) + if (cut) "…" else "",
                ),
                expanded = expanded,
                onExpandedChange = { open ->
                    if (!open || !cut) {
                        expanded = open
                    } else if (!loading) {
                        loading = true
                        loadFailed = false
                        scope.launch {
                            val full = CommentExpansion.completeBody(msg, runCatching { loadNewestComment(task.id) }.getOrNull())
                            loading = false
                            if (full != null) { complete = full; expanded = true } else loadFailed = true
                        }
                    }
                },
                style = ltype(LType.Meta),
                color = p.muted,
                collapsedLines = 2,
                knownCut = cut,
                loading = loading,
            )
            if (loadFailed) Text(CommentExpansion.LOAD_FAILED_NOTE, style = ltype(LType.Meta), color = p.danger)
        }
    }
}

/** The narrowest "on <task>" worth showing beside the name: "on" and the start of a word. In sp, so it grows with the font. */
internal val UPDATE_TASK_TITLE_MIN = 64.sp

/**
 * Updates header: name, "on <task>" and time on one line while the task title keeps at least
 * [UPDATE_TASK_TITLE_MIN]; otherwise (large text, long name) the title moves to its own line instead of
 * shrinking to a sliver (GH #378 QA round 2). The time is measured first, so a long name never pushes it out,
 * and the name stays on one line.
 */
@Composable
internal fun UpdateHeader(actor: String, taskTitle: String, ago: String) {
    val p = Orcha.palette
    Layout(
        content = {
            Text(actor, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("on $taskTitle", style = ltype(LType.Body), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(ago, style = ltype(LType.Meta), color = p.muted, maxLines = 1)
        },
    ) { measurables, constraints ->
        val (nameM, titleM, timeM) = measurables
        val gap = LSpace.xs.roundToPx()
        val bounded = constraints.hasBoundedWidth
        val maxW = constraints.maxWidth
        val time = timeM.measure(Constraints(maxWidth = maxW))
        val name = nameM.measure(Constraints(maxWidth = if (bounded) (maxW - gap - time.width).coerceAtLeast(0) else maxW))
        val titleRoom = if (bounded) maxW - name.width - time.width - 2 * gap else Constraints.Infinity
        if (titleRoom >= UPDATE_TASK_TITLE_MIN.roundToPx()) {
            val title = titleM.measure(Constraints(maxWidth = titleRoom))
            val w = constraints.constrainWidth(if (bounded) maxW else name.width + title.width + time.width + 2 * gap)
            val h = constraints.constrainHeight(maxOf(name.height, title.height, time.height))
            layout(w, h) {
                name.placeRelative(0, (h - name.height) / 2)
                title.placeRelative(name.width + gap, (h - title.height) / 2)
                time.placeRelative(w - time.width, (h - time.height) / 2)
            }
        } else {
            val title = titleM.measure(Constraints(maxWidth = maxW))
            val line = maxOf(name.height, time.height)
            val below = line + 2.dp.roundToPx()
            val h = constraints.constrainHeight(below + title.height)
            layout(maxW, h) {
                name.placeRelative(0, (line - name.height) / 2)
                time.placeRelative(maxW - time.width, (line - time.height) / 2)
                title.placeRelative(0, below)
            }
        }
    }
}
