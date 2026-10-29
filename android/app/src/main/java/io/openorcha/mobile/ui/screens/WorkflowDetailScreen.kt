package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.RepeatGroupViewDto
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.data.WorkflowTaskDto
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.ui.WorkflowDetailSegment
import io.openorcha.mobile.ui.WorkflowOperation
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Workflow detail (design #373 W03): header · owner bar · Needs-your-input strip ·
   operation notice · segments Tasks | Route | Review | Activity. Sheets (task W06, actions
   W07/W08, result review W09, owner decision W20, finish W13, …) open over it; system back
   closes the open sheet first, then pops detail → list (design §2). */

/** Which sheet is open over the detail. One at a time (one hand, one screen). */
internal sealed interface WorkflowSheet {
    data class Task(val taskId: String) : WorkflowSheet
    data class TaskAction(val taskId: String, val action: WorkflowLogic.TaskAction) : WorkflowSheet
    data class Menu(val action: WorkflowLogic.MenuAction) : WorkflowSheet
    data class ResultReview(val taskId: String) : WorkflowSheet
    data class Decision(val taskId: String) : WorkflowSheet
    data class ResolveFindings(val taskId: String) : WorkflowSheet
    data class Plan(val taskId: String) : WorkflowSheet
}

@Composable
internal fun WorkflowDetailScreen(controller: WorkflowsController, snapshot: ContainerSnapshot, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    var sheet by remember { mutableStateOf<WorkflowSheet?>(null) }
    val agents = snapshot.agents
    val nameOf = { id: String? -> agents.firstOrNull { it.id == id }?.alias }

    BackHandler(enabled = sheet == null) {
        if (s.inputOpen) controller.openInput(false) else controller.closeWorkflow()
    }

    val d = s.detail
    if (d == null) {
        Column(Modifier.fillMaxSize()) {
            DetailTopRow(title = "Workflow", onBack = controller::closeWorkflow)
            if (s.detailError != null) {
                LEmptyState(OrchaIcons.WifiOff, "Can't load this workflow", s.detailError ?: "", actionTitle = "Retry", onAction = controller::refreshDetail)
            } else WorkflowSkeleton()
        }
        return
    }
    val hasHuman = controller.hasHuman
    val busy = s.operation is WorkflowOperation.Sending || s.operation is WorkflowOperation.Uncertain
    val frozen = busy || s.detailStale

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 32.dp),
    ) {
        item(key = "top") { DetailTopRow(title = d.title, onBack = controller::closeWorkflow, onRefresh = controller::refreshDetail) }
        item(key = "header") {
            WorkflowHeader(
                d, ownerName = nameOf(d.ownerHumanId), hasHuman = hasHuman, frozen = frozen,
                onAction = { sheet = WorkflowSheet.Menu(it) },
            )
        }
        if (s.detailStale) item(key = "stale") {
            Banner(
                BannerKind.Warn, "Showing the last loaded workflow data. Refresh before making changes.",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp), action = "Retry", onAction = controller::refreshDetail,
            )
        }
        WorkflowLogic.writeReason(s.capability ?: d.capability, hasHuman)?.let { reason ->
            item(key = "cap") { Banner(BannerKind.Info, reason, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        }
        s.operation?.let { op -> item(key = "op") { OperationNotice(op, controller) } }
        WorkflowLogic.ownerBar(d)?.let { (task, text) ->
            item(key = "owner") {
                val isOwner = controller.actorId == d.ownerHumanId
                Banner(
                    BannerKind.Warn,
                    (if (isOwner) "Needs you. " else "Waiting for ${nameOf(d.ownerHumanId) ?: "the owner"}. ") + text,
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    action = if (isOwner && !frozen) "Decide…" else null,
                    onAction = { sheet = WorkflowSheet.Decision(task.id) },
                )
            }
        }
        val inputs = workflowInputItems(d, s.detail?.let { snapshot } ?: snapshot, controller.actorId)
        if (inputs.isNotEmpty()) item(key = "strip") {
            Banner(
                BannerKind.Info, "${inputs.size} need your input",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                action = if (s.inputOpen) "Close" else "View",
                onAction = { controller.openInput(!s.inputOpen) },
            )
        }
        if (s.inputOpen) {
            workflowInputList(this, inputs, d, onOpen = { item -> sheet = item.sheet(d) }, onOpenRequests = {})
            return@LazyColumn
        }
        item(key = "segments") {
            SecondaryTabRow(selectedTabIndex = s.detailSegment.ordinal, containerColor = p.bg, contentColor = p.text) {
                WorkflowDetailSegment.entries.forEach { seg ->
                    val label = when (seg) {
                        WorkflowDetailSegment.Tasks -> "Tasks ${d.tasks.size}"
                        WorkflowDetailSegment.Review -> "Review ${d.reviewRounds.size}/${d.roundLimit}"
                        else -> seg.label
                    }
                    Tab(selected = s.detailSegment == seg, onClick = { controller.selectDetailSegment(seg) }, text = { Text(label, maxLines = 1) })
                }
            }
        }
        when (s.detailSegment) {
            WorkflowDetailSegment.Tasks -> tasksSegment(this, d, nameOf, dim = s.detailStale) { sheet = WorkflowSheet.Task(it) }
            WorkflowDetailSegment.Route -> routeSegment(this, d) { sheet = WorkflowSheet.Task(it) }
            WorkflowDetailSegment.Review -> reviewSegment(this, d, hasHuman, frozen,
                onRecord = { sheet = WorkflowSheet.Menu(WorkflowLogic.MenuAction.ReviewRound) },
                onResolve = { sheet = WorkflowSheet.ResolveFindings(it) })
            WorkflowDetailSegment.Activity -> activitySegment(this, s.activity, s.activityLoading, s.activityError,
                hasMore = s.activityNextAt != null, titleOf = { id -> d.tasks.firstOrNull { it.id == id }?.title },
                onMore = controller::loadEarlierActivity, onRetry = controller::refreshDetail)
        }
    }

    WorkflowSheetHost(
        sheet = sheet,
        controller = controller,
        detail = d,
        snapshot = snapshot,
        onOpenTask = onOpenTask,
        onSheet = { sheet = it },
    )
}

@Composable
internal fun DetailTopRow(title: String, onBack: () -> Unit, onRefresh: (() -> Unit)? = null) {
    val p = Orcha.palette
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back to workflows", tint = p.text) }
        Text(title, style = ltype(LType.Meta), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        onRefresh?.let { IconButton(onClick = it) { Icon(OrchaIcons.Refresh, "Refresh workflow", tint = p.text2) } }
    }
}

@Composable
private fun WorkflowHeader(
    d: WorkflowDetailDto,
    ownerName: String?,
    hasHuman: Boolean,
    frozen: Boolean,
    onAction: (WorkflowLogic.MenuAction) -> Unit,
) {
    val p = Orcha.palette
    var goalExpanded by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(d.title, style = ltype(LType.Title), color = p.text)
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LStatusGlyph(WorkflowLogic.glyphStatus(d))
            Text(WorkflowLogic.workflowLabel(d), style = ltype(LType.Meta), color = p.text2)
            ownerName?.let { LAvatar(it, size = 18.dp); Text(it, style = ltype(LType.Meta), color = p.text2) }
            LTag(WorkflowLogic.modeLabel(d.executionMode))
            Text(
                "${d.progress.accepted}/${d.progress.total} tasks · ${d.progress.objectivesAccepted}/${d.progress.objectivesTotal} objectives",
                style = ltype(LType.Meta), color = p.text2,
            )
            if (d.goalAcceptedRevision == d.goalRevision) LTag("Goal accepted", tint = p.ok) else LTag("Goal needs acceptance", tint = p.warn)
            if (d.semanticsVersion >= 2) Text("Agent turns ${d.turnsUsed} of ${d.turnAllowance}", style = ltype(LType.Meta), color = p.text2)
        }
        if (d.goal.isNotBlank()) {
            Text(
                d.goal, style = ltype(LType.Body), color = p.text2,
                maxLines = if (goalExpanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis,
            )
            if (!goalExpanded && d.goal.length > 120) {
                Text("More", style = ltype(LType.Meta), color = p.accent, modifier = Modifier.combinedClickable(onClick = { goalExpanded = true }))
            }
        }
        val primary = WorkflowLogic.primaryAction(d, hasHuman)
        val primaryReason = if (primary == WorkflowLogic.MenuAction.Finish) null else WorkflowLogic.menuReason(d, primary, hasHuman)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LButton(primary.label, { onAction(primary) }, Modifier.weight(1f), kind = LButtonKind.Primary, enabled = !frozen && primaryReason == null)
            Box {
                IconButton(onClick = { menu = true }) { Icon(OrchaIcons.MoreVert, "More workflow actions", tint = p.text) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    WorkflowLogic.overflow(d, hasHuman).forEach { a ->
                        if (a == null) {
                            HorizontalDivider()
                        } else {
                            val reason = if (frozen) "Wait for the current save to finish." else WorkflowLogic.menuReason(d, a, hasHuman)
                            val label = if (a == WorkflowLogic.MenuAction.Hide && d.hidden) "Restore workflow…" else a.label
                            DropdownMenuItem(
                                enabled = reason == null,
                                text = {
                                    Column {
                                        Text(label, color = if (a.danger && reason == null) p.danger else p.text)
                                        reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
                                    }
                                },
                                onClick = { menu = false; onAction(a) },
                            )
                        }
                    }
                }
            }
        }
        primaryReason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
    }
}

/** W03 operation notice: sending, uncertain (Check saved result / Retry same request), refused. */
@Composable
internal fun OperationNotice(op: WorkflowOperation, controller: WorkflowsController) {
    val m = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
    when (op) {
        is WorkflowOperation.Sending -> Banner(BannerKind.Info, "Saving… keep this screen open. (${op.label})", m)
        is WorkflowOperation.Uncertain -> Column(m, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Banner(BannerKind.Warn, op.message)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LButton("Check saved result", { controller.checkSaved() }, kind = LButtonKind.Secondary)
                LButton("Retry same request", { controller.retrySame() }, kind = LButtonKind.Secondary)
            }
        }
        is WorkflowOperation.Refused -> Banner(BannerKind.Danger, op.message, m, action = "Dismiss", onAction = controller::dismissOperation)
    }
}

// ---- W04 Tasks segment ----

private fun tasksSegment(
    scope: LazyListScope,
    d: WorkflowDetailDto,
    nameOf: (String?) -> String?,
    dim: Boolean,
    onOpen: (String) -> Unit,
) {
    if (d.tasks.isEmpty()) {
        scope.item(key = "notasks") { LEmptyState(OrchaIcons.Checklist, "No tasks yet", "Add new or existing tasks from the ⋯ menu.") }
        return
    }
    WorkflowLogic.groupRows(d.tasks, d.repeatGroups).forEach { g ->
        when (g) {
            is WorkflowLogic.TaskRowGroup.Single -> scope.item(key = "t:${g.task.id}") {
                WorkflowTaskRow(g.task, d, nameOf, dim, onOpen)
            }
            is WorkflowLogic.TaskRowGroup.Loop -> scope.item(key = "g:${g.group.id}:${g.tasks.first().id}") {
                LoopBracket(g.group, d, nameOf) {
                    g.tasks.forEach { WorkflowTaskRow(it, d, nameOf, dim, onOpen) }
                }
            }
        }
    }
}

@Composable
private fun LoopBracket(group: RepeatGroupViewDto, d: WorkflowDetailDto, nameOf: (String?) -> String?, content: @Composable () -> Unit) {
    val p = Orcha.palette
    val line = p.accent
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 6.dp)
            .drawBehind {
                drawLine(line, Offset(0f, 0f), Offset(0f, size.height), strokeWidth = 3.dp.toPx())
            }
            .padding(start = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(group.name, style = ltype(LType.BodyEmph), color = p.text)
        val reviewTitle = d.tasks.firstOrNull { it.id == group.reviewTask }?.title
        Text(
            WorkflowLogic.loopSentence(group, reviewTitle, nameOf(group.escalationOwnerId) ?: nameOf(d.ownerHumanId)),
            style = ltype(LType.Meta), color = p.text2,
        )
        RoundDots(group)
        content()
    }
}

@Composable
internal fun RoundDots(group: RepeatGroupViewDto) {
    val p = Orcha.palette
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        WorkflowLogic.roundDots(group).forEach { dot ->
            val m = Modifier.size(8.dp)
            when (dot) {
                WorkflowLogic.Dot.Done -> Box(m.background(p.accent, CircleShape))
                WorkflowLogic.Dot.Current -> Box(m.background(p.accentSoft, CircleShape).drawBehind {
                    drawCircle(p.accent, radius = size.minDimension / 2, style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
                })
                WorkflowLogic.Dot.Remaining -> Box(m.background(p.surface2, CircleShape))
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkflowTaskRow(t: WorkflowTaskDto, d: WorkflowDetailDto, nameOf: (String?) -> String?, dim: Boolean, onOpen: (String) -> Unit) {
    val p = Orcha.palette
    val withdrawn = t.withdrawnAt != null
    val notSelected = t.routeState == "not_selected"
    val sub = buildList {
        add(t.displayState.label)
        t.round?.let { add("Round $it") }
        t.blockers.firstOrNull()?.let { add(it.message) }
        t.displayState.releaseAvailableAt?.let { add("Release lost worker becomes available at ${shortTime(it)}") }
        if (withdrawn) add("Withdrawn by ${nameOf(t.withdrawnBy) ?: t.withdrawnBy ?: "someone"}")
    }.joinToString(" · ")
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = { onOpen(t.id) }, onLongClick = { onOpen(t.id) })
            .alpha(if (withdrawn || dim) 0.55f else 1f)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LStatusGlyph(t.status)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                t.title, style = ltype(LType.Body), color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (notSelected) TextDecoration.LineThrough else null,
            )
            Text(sub, style = ltype(LType.Meta), color = p.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LTag("Autonomy ${t.autonomy.uppercase()}")
                if (t.displayState.listWarning) LTag(t.displayState.warning ?: "Check this task", tint = p.warn)
                if (notSelected) LTag("Not selected")
            }
        }
        if (t.assigneeIds.isEmpty()) {
            Box(Modifier.size(22.dp).drawBehind {
                drawCircle(p.muted, style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx(),
                    pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(4f, 4f))))
            })
        } else t.assigneeIds.take(2).forEach { id -> LAvatar(nameOf(id) ?: "?", size = 22.dp) }
        Icon(OrchaIcons.ChevronRight, null, tint = p.muted)
    }
}

internal fun shortTime(iso: String): String =
    runCatching { java.time.OffsetDateTime.parse(iso).toLocalTime().withNano(0).toString().take(5) }.getOrDefault(iso)

// ---- W05 Route segment (read-only after Save) ----

private fun routeSegment(scope: LazyListScope, d: WorkflowDetailDto, onOpen: (String) -> Unit) {
    scope.item(key = "routehead") { RouteHeader(d, onOpen) }
}

@Composable
private fun RouteHeader(d: WorkflowDetailDto, onOpen: (String) -> Unit) {
    val p = Orcha.palette
    var graph by remember { mutableStateOf(false) }
    val titleOf = { id: String? -> d.tasks.firstOrNull { it.id == id }?.title }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "Routes and the repeat group were set when this workflow was created. Drawing the graph stays on the laptop.",
            style = ltype(LType.Meta), color = p.muted,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LButton("List", { graph = false }, kind = if (!graph) LButtonKind.Primary else LButtonKind.Secondary)
            LButton("Graph", { graph = true }, kind = if (graph) LButtonKind.Primary else LButtonKind.Secondary)
        }
        if (graph) {
            WorkflowGraph(d, onOpen)
        } else d.tasks.forEach { t ->
            Column(
                Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp))
                    .combinedClickableCompat { onOpen(t.id) }.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LStatusGlyph(t.status)
                    Text(t.title, style = ltype(LType.Body), color = p.text)
                }
                Text(WorkflowLogic.dependsLine(t, d.tasks), style = ltype(LType.Meta), color = p.text2)
                t.routes.forEach { r -> Text(WorkflowLogic.routeSentence(r, titleOf), style = ltype(LType.Meta), color = p.text2) }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
internal fun Modifier.combinedClickableCompat(onClick: () -> Unit): Modifier = this.combinedClickable(onClick = onClick)

// ---- W14 Review segment ----

private fun reviewSegment(
    scope: LazyListScope,
    d: WorkflowDetailDto,
    hasHuman: Boolean,
    frozen: Boolean,
    onRecord: () -> Unit,
    onResolve: (String) -> Unit,
) {
    scope.item(key = "reviewhead") {
        val p = Orcha.palette
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Round limit ${d.roundLimit} · used ${d.reviewRounds.size}", style = ltype(LType.BodyEmph), color = p.text)
            if (d.limitReached) Banner(BannerKind.Warn, "Limit reached — no new starts")
            val reason = WorkflowLogic.menuReason(d, WorkflowLogic.MenuAction.ReviewRound, hasHuman)
            LButton("Record review outcome", onRecord, enabled = !frozen && reason == null, kind = LButtonKind.Secondary)
            reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
        }
    }
    if (d.reviewRounds.isEmpty()) {
        scope.item(key = "noreview") { LEmptyState(OrchaIcons.Verified, "No review rounds yet", "Recorded review outcomes appear here, one card per round.") }
        return
    }
    scope.items(d.reviewRounds, key = { "r:${it.id}" }) { r ->
        val p = Orcha.palette
        val title = { id: String? -> d.tasks.firstOrNull { it.id == id }?.title ?: "a task" }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
                .background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Round ${r.roundNumber}", style = ltype(LType.BodyEmph), color = p.text)
                r.outcome?.let { LTag(it.replace('_', ' '), tint = if (it == "accepted") p.ok else p.warn) }
            }
            Text("Review: ${title(r.reviewTaskId)}" + (r.reviewWorkRevision?.let { " · revision $it" } ?: ""), style = ltype(LType.Meta), color = p.text2)
            r.reviewedTaskId?.let {
                Text("Reviewed: ${title(it)}" + (r.reviewedWorkRevision?.let { v -> " · revision $v" } ?: ""), style = ltype(LType.Meta), color = p.text2)
            }
            r.reviewedArtifact?.items?.takeIf { it.isNotEmpty() }?.let { items ->
                Text("Files: " + items.joinToString(", ") { "v${it.deliverableVersion} · ${it.sha256.take(8)}" }, style = ltype(LType.Meta), color = p.muted)
            }
            r.correctionTaskId?.let { Text("Correction: ${title(it)}", style = ltype(LType.Meta), color = p.text2) }
            if (r.resolvedByOwner != null) {
                Text("Resolved by owner decision: ${r.resolvedReason.orEmpty()}", style = ltype(LType.Meta), color = p.text2)
            } else if (r.outcome == "changes_requested") {
                val reason = WorkflowLogic.actionReason(d, "resolve_loop", hasHuman)
                    ?.takeIf { d.availableActions.any { a -> a.action == "resolve_loop" } }
                if (d.availableActions.any { it.action == "resolve_loop" }) {
                    LButton("Resolve findings by owner decision…", { onResolve(r.reviewTaskId) }, enabled = !frozen && reason == null, kind = LButtonKind.Ghost)
                }
            }
        }
    }
}

// ---- W15 Activity segment ----

private fun activitySegment(
    scope: LazyListScope,
    rows: List<io.openorcha.mobile.data.WorkflowActivityDto>,
    loading: Boolean,
    error: String?,
    hasMore: Boolean,
    titleOf: (String?) -> String?,
    onMore: () -> Unit,
    onRetry: () -> Unit,
) {
    if (error != null) scope.item(key = "acterr") {
        Banner(
            BannerKind.Warn,
            if (rows.isEmpty()) error else "Showing previously loaded activity.",
            Modifier.padding(horizontal = 16.dp, vertical = 4.dp), action = "Retry", onAction = onRetry,
        )
    }
    if (rows.isEmpty() && loading) scope.item(key = "actload") { WorkflowSkeleton() }
    else if (rows.isEmpty() && error == null) scope.item(key = "actnone") { LEmptyState(OrchaIcons.Schedule, "No activity yet", "Changes to this workflow appear here.") }
    scope.items(rows, key = { "a:${it.id}" }) { a ->
        val p = Orcha.palette
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LAvatar(a.actorAlias.ifBlank { "?" }, isAI = a.actorKind == "ai", size = 22.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "${a.actorAlias} · ${WorkflowActivityCopy.label(a.event)}" + (titleOf(a.taskId)?.let { " · $it" } ?: ""),
                    style = ltype(LType.Body), color = p.text,
                )
                WorkflowActivityCopy.body(a.detail)?.let { Text(it, style = ltype(LType.Meta), color = p.text2) }
            }
            Text(relativeAge(a.createdAt), style = ltype(LType.Meta), color = p.muted)
        }
    }
    if (hasMore) scope.item(key = "actmore") {
        LButton(if (loading) "Loading…" else "Load earlier activity", onMore, Modifier.fillMaxWidth().padding(16.dp), enabled = !loading)
    }
}

/** Activity event names → readable labels; unknown events fall back to the event with spaces. */
internal object WorkflowActivityCopy {
    fun label(event: String): String = event.replace('.', ' ').replace('_', ' ').trim().replaceFirstChar { it.uppercase() }

    /** Reason / warning / supplier lines from the event detail, when present. */
    fun body(detail: kotlinx.serialization.json.JsonObject): String? =
        listOf("reason", "warning", "supplier", "note", "message")
            .mapNotNull { k -> (detail[k] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { it.isNotBlank() && it != "null" } }
            .joinToString(" · ")
            .ifBlank { null }
}

@Composable
private fun Spacer8() = Spacer(Modifier.width(8.dp).height(8.dp))
