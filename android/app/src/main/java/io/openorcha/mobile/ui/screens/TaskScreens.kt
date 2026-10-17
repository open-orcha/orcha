package io.openorcha.mobile.ui.screens

/** Owns task detail presentation and its approval and close entry points. */

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.Role
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import io.openorcha.mobile.domain.TaskInsightsUx
import io.openorcha.mobile.ui.rememberTaskInsights
import io.openorcha.mobile.ui.rememberTaskDeliverables
import io.openorcha.mobile.domain.DeliverablesUx
import io.openorcha.mobile.data.DeliverableDto
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.MarkdownLite
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LPriorityGlyph
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.priorityLabel
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 05 — Task detail, Linear style (mirrors iOS TaskScreens.swift): breadcrumb,
   display title, one-line meta row, verification / plan cards, done-when, properties,
   dependencies, Activity / Runs panes, and a bottom comment composer.
   ============================================================================= */

private enum class DetailPane { Activity, Runs }

@Composable
fun TaskDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onOpenThread: () -> Unit,
    onOpenTask: (String) -> Unit,
    onPrepareClose: () -> Unit,
    onCancelTask: (String?) -> Unit,
    onVerify: (Boolean, String?) -> Unit,
    onDecidePlan: (Boolean, String?) -> Unit,
    onOpenRun: (RunDto) -> Unit,
    /** Posts to the task thread from the bottom composer. When null, the composer opens the thread. */
    onSendMessage: ((String) -> Unit)? = null,
    /** Reloads the workspace snapshot after a reassign / reviewer change (wire `viewModel::refreshSelected`). */
    onTaskChanged: (() -> Unit)? = null,
) {
    val p = Orcha.palette
    val task = state.selectedTask
    val agents = state.snapshot?.agents.orEmpty()
    var menuOpen by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var closeReason by remember { mutableStateOf("") }
    var showVerify by remember { mutableStateOf(false) }
    var verifyRejecting by remember { mutableStateOf(false) }
    var showPlan by remember { mutableStateOf(false) }
    var paneName by rememberSaveable { mutableStateOf(DetailPane.Activity.name) }
    val pane = DetailPane.valueOf(paneName)
    val closable = task != null && !task.isRoot && task.status !in setOf("completed", "cancelled")
    // Parity features (evidence, Verdikt, goal chain, routines, reassign, reviewer): own state, see TaskInsightsController.
    val insights = rememberTaskInsights()
    val ins by insights.state.collectAsState()
    val container = state.selectedContainer
    var sheet by remember { mutableStateOf<InsightSheetKind?>(null) }
    LaunchedEffect(task?.id, task?.status, container?.baseUrl) {
        if (task != null && container != null) insights.load(container, task.id)
    }
    LaunchedEffect(ins.notice) {
        if (ins.notice != null) { delay(4_000); insights.clearNotice() }
    }
    // Deliverables (web P2): own state too, see TaskDeliverablesController.
    val deliverables = rememberTaskDeliverables()
    val dlv by deliverables.state.collectAsState()
    var openDeliverable by remember { mutableStateOf<DeliverableDto?>(null) }
    LaunchedEffect(task?.id, task?.status, container?.baseUrl) {
        if (task != null && container != null) deliverables.load(container, task.id)
    }
    LaunchedEffect(dlv.notice) {
        if (dlv.notice != null) { delay(4_000); deliverables.clearNotice() }
    }
    val attachDeliverable = rememberDeliverablePicker { name, mime, read ->
        if (task != null && container != null) deliverables.upload(container, task.id, name, mime, read)
    }
    val afterChange: () -> Unit = { sheet = null; onTaskChanged?.invoke() ?: onRefresh() }
    val actingHuman = agents.firstOrNull { it.id == container?.humanAgentId }
    val canAssignReviewer = container?.humanAgentId != null && actingHuman?.memberRole != "viewer"

    Scaffold(
        containerColor = p.bg,
        topBar = {
            LTopBar(
                title = task?.shortId ?: "Task",
                monoTitle = task != null,
                onBack = onBack,
            ) {
                Box {
                    IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More actions", tint = p.text2) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, containerColor = p.raised) {
                        DropdownMenuItem(
                            text = { Text("Refresh", style = ltype(LType.Body), color = p.text) },
                            onClick = {
                                menuOpen = false
                                onRefresh()
                                if (task != null && container != null) deliverables.load(container, task.id)
                            },
                        )
                        if (task != null && closable) {
                            // Same rule as iOS and the server: no reassign while it awaits review.
                            val canReassign = TaskInsightsUx.canReassign(task.isRoot, task.status)
                            DropdownMenuItem(
                                enabled = canReassign,
                                text = { Text("Reassign…", style = ltype(LType.Body), color = if (canReassign) p.text else p.faint) },
                                onClick = { menuOpen = false; insights.clearError(); sheet = InsightSheetKind.Reassign },
                            )
                        }
                        if (task != null && !task.isRoot) {
                            DropdownMenuItem(
                                text = { Text("Make recurring…", style = ltype(LType.Body), color = p.text) },
                                onClick = { menuOpen = false; insights.clearError(); sheet = InsightSheetKind.Recurring },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Close task…", style = ltype(LType.Body), color = if (closable) p.danger else p.faint) },
                            enabled = closable,
                            onClick = { menuOpen = false; onPrepareClose(); closing = true },
                        )
                    }
                }
            }
        },
        bottomBar = {
            if (task != null) {
                // Draft survives rotation, and a failed send puts the text back instead of losing it.
                var draft by rememberSaveable(task.id) { mutableStateOf("") }
                var pending by rememberSaveable(task.id) { mutableStateOf<String?>(null) }
                var sawInFlight by remember { mutableStateOf(false) }
                LaunchedEffect(state.actionInFlight, state.error) {
                    val sent = pending ?: return@LaunchedEffect
                    when {
                        state.actionInFlight -> sawInFlight = true
                        state.error != null -> {
                            if (draft.isEmpty()) draft = sent
                            pending = null; sawInFlight = false
                        }
                        sawInFlight -> { pending = null; sawInFlight = false }
                    }
                }
                TaskCommentComposer(
                    assignee = task.assignees.firstOrNull() ?: task.ownerAlias,
                    busy = state.actionInFlight,
                    onSend = onSendMessage?.let { send -> { text: String -> pending = text; send(text) } },
                    onOpenThread = onOpenThread,
                    draftState = draft to { draft = it },
                )
            }
        },
    ) { padding ->
        if (task == null) {
            LEmptyState(
                icon = OrchaIcons.Checklist,
                title = "Task not found",
                message = "Refresh the workspace to load it again.",
                modifier = Modifier.padding(padding).padding(LSpace.l),
                actionTitle = "Refresh",
                onAction = onRefresh,
            )
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
            verticalArrangement = Arrangement.spacedBy(LSpace.xl),
        ) {
            ins.notice?.let { item(key = "notice") { Banner(BannerKind.Info, it) } }
            dlv.notice?.let { item(key = "dlv-notice") { Banner(BannerKind.Info, it) } }
            if (TaskInsightsUx.hasAncestry(ins.goalChain)) {
                item(key = "goal") { GoalChainBreadcrumb(ins.goalChain, onOpenTask) }
            }
            item(key = "header") { TaskDetailHeader(task, state.snapshot?.container?.name ?: state.selectedContainer?.displayName, agents) }
            if (task.status == "needs_verification") {
                item(key = "verify") {
                    VerificationCard(
                        task = task,
                        busy = state.actionInFlight,
                        onReview = { verifyRejecting = false; showVerify = true },
                        onReject = { verifyRejecting = true; showVerify = true },
                        onAccept = { onVerify(true, null) },
                        review = { ManagerReviewNote(task, reviewerName(task, agents)) },
                        proof = {
                            EvidenceProofBlock(
                                insights = ins,
                                baseUrl = container?.baseUrl,
                                canRunVerdikt = container?.humanAgentId != null,
                                onRetry = { container?.let { insights.load(it, task.id) } },
                                onRunVerdikt = { container?.let { insights.runVerdikt(it, task.id) {} } },
                            )
                        },
                    )
                }
            }
            if (task.status != "needs_verification" && TaskInsightsUx.managerReviewLine(task.managerReview) != null) {
                item(key = "mgr") { LCard(padding = LSpace.l) { ManagerReviewNote(task, reviewerName(task, agents)) } }
            }
            val latestVerdikt = ins.verdikt?.runs?.maxByOrNull { it.createdAt.orEmpty() }
            if (task.status != "needs_verification" && latestVerdikt != null) {
                item(key = "verdikt") {
                    LCard(padding = LSpace.l) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            VerdiktSection(latestVerdikt, ins.verdikt?.settings, task.id, container?.baseUrl, canRun = false, busy = ins.busy, onRun = {})
                        }
                    }
                }
            }
            if (isPlanWaiting(task)) {
                item(key = "plan") { PlanWaitingCard(task) { showPlan = true } }
            }
            task.description?.takeIf { it.isNotBlank() }?.let {
                item(key = "desc") { MarkdownText(it) }
            }
            if (task.status != "needs_verification") {
                item(key = "dod") { DoneWhenBlock(task.definitionOfDone) }
            }
            item(key = "props") {
                TaskPropertiesSection(
                    task, agents,
                    routineText = ins.routines.firstOrNull()?.let { r ->
                        (if (r.enabled) "Recurring" else "Recurring · paused") + r.scheduleText.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
                    },
                    onPickReviewer = if (canAssignReviewer) ({ insights.clearError(); sheet = InsightSheetKind.Reviewer }) else null,
                )
            }
            if (task.dependsOn.isNotEmpty()) {
                item(key = "deps") { DependenciesSection(task.dependsOn, state.snapshot?.tasks.orEmpty(), onOpenTask) }
            }
            if (dlv.available && !task.isRoot) {
                item(key = "deliverables") {
                    TaskDeliverablesSection(
                        state = dlv,
                        canAttach = DeliverablesUx.canAttach(task, container?.humanAgentId != null && actingHuman?.memberRole != "viewer"),
                        onAttach = attachDeliverable,
                        onOpen = { openDeliverable = it },
                    )
                }
            }
            item(key = "panes") {
                Column(verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
                    LSegmented(
                        options = listOf(
                            DetailPane.Activity to "Activity ${activityEntries(task, state.taskMessages).size}",
                            DetailPane.Runs to "Runs ${state.taskRuns.size}",
                        ),
                        selection = pane,
                        onSelect = { paneName = it.name },
                    )
                    AnimatedContent(pane, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "pane") { current ->
                        when (current) {
                            DetailPane.Activity -> ActivityTimeline(task, state.taskMessages, agents, onOpenThread)
                            DetailPane.Runs -> RunsTimeline(state.taskRuns, onOpenRun)
                        }
                    }
                }
            }
            state.error?.let { item(key = "error") { Banner(BannerKind.Danger, it) } }
        }
    }

    TaskCloseDialog(
        task = task?.takeIf { closing },
        implications = state.closeImplications,
        reason = closeReason,
        onReasonChange = { closeReason = it },
        onDismiss = { closing = false },
        onClose = { closing = false; onCancelTask(closeReason.ifBlank { null }) },
    )
    if (showVerify && task != null) {
        VerifySheet(task, state.actionInFlight, onDismiss = { showVerify = false }, startRejecting = verifyRejecting) { approve, feedback ->
            showVerify = false; onVerify(approve, feedback)
        }
    }
    if (task != null && container != null) {
        when (sheet) {
            InsightSheetKind.Reassign -> ReassignSheet(task, agents, ins.busy, ins.actionError, onDismiss = { sheet = null }) { agent ->
                insights.reassign(container, task.id, agent.id, agent.alias, afterChange)
            }
            InsightSheetKind.Reviewer -> ReviewerPickerSheet(task, agents, ins.busy, ins.actionError, onDismiss = { sheet = null }) { id ->
                insights.setReviewer(container, task.id, id, afterChange)
            }
            InsightSheetKind.Recurring -> MakeRecurringSheet(
                task, agents, ins.busy, ins.actionError,
                onDismiss = { sheet = null },
                onPreview = { cron, tz -> insights.preview(container, cron, tz) },
                onCreate = { build -> insights.createRoutine(container, build) { sheet = null } },
            )
            null -> Unit
        }
    }
    val opened = openDeliverable
    if (opened != null && task != null && container != null) {
        DeliverableSheet(
            controller = deliverables,
            container = container,
            taskId = task.id,
            deliverable = opened,
            tasks = state.snapshot?.tasks.orEmpty(),
            onOpenTask = { openDeliverable = null; onOpenTask(it) },
            onDismiss = { openDeliverable = null },
        )
    }
    if (showPlan && task != null) {
        PlanApprovalSheet(task, state.actionInFlight, onDismiss = { showPlan = false }) { approve, reason ->
            showPlan = false; onDecidePlan(approve, reason)
        }
    }
}

/* ---------- shared Linear top bar for the task / run / create screens ---------- */

/** Small centred title over the window colour with a hairline divider (no Material header). */
@Composable
internal fun LTopBar(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    monoTitle: Boolean = false,
    backIsClose: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val p = Orcha.palette
    Column(modifier.fillMaxWidth().background(p.bg).statusBarsPadding()) {
        Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = LSpace.xs)) {
            if (onBack != null) {
                IconButton(onClick = onBack, modifier = Modifier.align(Alignment.CenterStart)) {
                    Icon(if (backIsClose) OrchaIcons.Close else OrchaIcons.ArrowBack, if (backIsClose) "Close" else "Back", tint = p.text2)
                }
            }
            Column(
                Modifier.align(Alignment.Center).padding(horizontal = 56.dp).semantics(mergeDescendants = true) { heading() },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    title,
                    style = if (monoTitle) ltype(LType.Mono).copy(fontWeight = FontWeight.SemiBold) else ltype(LType.Headline),
                    color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                subtitle?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = ltype(LType.Micro), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically, content = actions)
        }
        LDivider()
    }
}

/* ---------- header ---------- */

@Composable
private fun TaskDetailHeader(task: TaskDto, projectName: String?, agents: List<AgentDto>) {
    val p = Orcha.palette
    Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.semantics(mergeDescendants = true) {
                contentDescription = "${projectName ?: "Project"}, task ${task.shortId}"
            },
        ) {
            Text(projectName ?: "Project", style = ltype(LType.Meta), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(12.dp))
            Text(task.shortId, style = ltype(LType.Mono), color = p.faint)
            if (task.isRoot) LTag("Root")
        }
        Text(task.title, style = ltype(LType.Display), color = p.text, modifier = Modifier.semantics { heading() })
        TaskMetaRow(task, agents)
    }
}

/**
 * One line: status · priority · assignee · age. Never wraps — if it doesn't fit, the
 * age (and its dot) is dropped first, then the assignee name truncates.
 */
@Composable
private fun TaskMetaRow(task: TaskDto, agents: List<AgentDto>) {
    val p = Orcha.palette
    val assignee = task.assignees.firstOrNull() ?: task.ownerAlias
    val ago = MobileUx.agoLabel(task.completedAt ?: task.startedAt ?: task.createdAt)
    val meta = ltype(LType.Meta)
    val dot: @Composable () -> Unit = { Text("·", style = meta, color = p.faint, modifier = Modifier.semantics { contentDescription = "" }) }
    // custom layout: measure the age group last and drop it if the row would overflow
    Layout(
        content = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AnimatedContent(
                        task.status,
                        transitionSpec = { (scaleIn(initialScale = 0.3f) + fadeIn()) togetherWith fadeOut() },
                        label = "status-glyph",
                    ) { LStatusGlyph(it, size = 15.dp) }
                    Text(MobileUx.statusCopy(task.status).capitalizedFirst(), style = meta, color = p.text2, maxLines = 1)
                }
                dot()
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LPriorityGlyph(task.priority, size = 13.dp)
                    Text(priorityLabel(task.priority), style = meta, color = p.text2, maxLines = 1)
                }
                dot()
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f, fill = false)) {
                    if (assignee != null) {
                        LAvatar(assignee, isAI = isAiAlias(assignee, agents), size = 18.dp)
                        Text(assignee, style = meta, color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } else {
                        Text("Unassigned", style = meta, color = p.faint, maxLines = 1)
                    }
                }
            }
            if (ago != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    dot()
                    Text(ago, style = meta, color = p.faint, maxLines = 1)
                }
            }
        },
    ) { measurables, constraints ->
        val gap = LSpace.s.roundToPx()
        val loose = constraints.copy(minWidth = 0)
        val agePlaceable = measurables.getOrNull(1)?.measure(loose.copy(maxWidth = Int.MAX_VALUE.coerceAtMost(constraints.maxWidth)))
        val mainNatural = measurables[0].maxIntrinsicWidth(constraints.maxHeight.coerceAtMost(10_000))
        val showAge = agePlaceable != null && mainNatural + gap + agePlaceable.width <= constraints.maxWidth
        val mainMax = if (showAge) constraints.maxWidth - gap - agePlaceable!!.width else constraints.maxWidth
        val main = measurables[0].measure(loose.copy(maxWidth = mainMax))
        val height = maxOf(main.height, if (showAge) agePlaceable!!.height else 0)
        val width = if (showAge) main.width + gap + agePlaceable!!.width else main.width
        layout(width, height) {
            main.placeRelative(0, (height - main.height) / 2)
            if (showAge) agePlaceable!!.placeRelative(main.width + gap, (height - agePlaceable.height) / 2)
        }
    }
}

/* ---------- verification + plan cards ---------- */

@Composable
private fun VerificationCard(
    task: TaskDto,
    busy: Boolean,
    onReview: () -> Unit,
    onReject: () -> Unit,
    onAccept: () -> Unit,
    review: @Composable () -> Unit = {},
    proof: @Composable () -> Unit = {},
) {
    val p = Orcha.palette
    LCard(padding = LSpace.l) {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                LStatusGlyph("needs_verification", size = 14.dp)
                Text("Awaiting your verification", style = ltype(LType.Headline), color = p.text, modifier = Modifier.semantics { heading() })
            }
            (task.result ?: task.messageSummary?.last?.body)?.let(ActivityCopy::humanize)?.takeIf { it.isNotBlank() }?.let { result ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Result", style = ltype(LType.Micro), color = p.faint)
                    Text(
                        inlineMarkdown(result),
                        style = ltype(LType.Body), color = p.text2, maxLines = 6, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            proof()
            review()
            DoneWhenBlock(task.definitionOfDone, compact = true)
            Text(
                "See full review",
                style = ltype(LType.Meta),
                color = p.accent,
                modifier = Modifier.clickable(onClick = onReview).heightIn(min = 48.dp).padding(vertical = 14.dp),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LSpace.s, Alignment.End)) {
                LButton("Reject…", onReject, kind = LButtonKind.Secondary, enabled = !busy)
                LButton("Accept", onAccept, icon = OrchaIcons.Check, kind = LButtonKind.Primary, enabled = !busy)
            }
        }
    }
}

@Composable
private fun PlanWaitingCard(task: TaskDto, onReview: () -> Unit) {
    val p = Orcha.palette
    LCard(padding = LSpace.l) {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                Icon(OrchaIcons.Checklist, null, tint = p.violet, modifier = Modifier.size(16.dp))
                Text("Plan waiting for approval", style = ltype(LType.Headline), color = p.text, modifier = Modifier.weight(1f).semantics { heading() })
                task.planMessage?.authorAlias?.let { LAvatar(it, isAI = true, size = 20.dp) }
            }
            Text(
                // Preview: drop markdown heading markers ("## Plan") so the card reads as prose.
                inlineMarkdown(task.planMessage?.body.orEmpty().lines().joinToString("\n") { it.trimStart().trimStart('#').trimStart() }),
                style = ltype(LType.Body), color = p.text2, maxLines = 4, overflow = TextOverflow.Ellipsis,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                LButton("Review plan", onReview, kind = LButtonKind.Primary, size = LSize.Small)
            }
        }
    }
}

/** "Done when" — the definition of done as green-check lines. */
@Composable
private fun DoneWhenBlock(definitionOfDone: String?, compact: Boolean = false) {
    val p = Orcha.palette
    val lines = (definitionOfDone ?: "").split("\n").map { it.trim().removePrefix("- ") }.filter { it.isNotBlank() }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "Done when",
            style = ltype(if (compact) LType.Micro else LType.Meta),
            color = p.faint,
            modifier = Modifier.semantics { heading() },
        )
        if (lines.isEmpty()) Text("No definition of done was provided.", style = ltype(LType.Body), color = p.faint)
        lines.forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                Box(Modifier.padding(top = 3.dp)) { LStatusGlyph("needs_verification", size = 14.dp) }
                Text(inlineMarkdown(line), style = ltype(LType.Body), color = p.text)
            }
        }
    }
}

/** Renders the portal's inline-markdown subset (code, bold, italic, links) as one string. */
@Composable
internal fun inlineMarkdown(text: String): AnnotatedString {
    val p = Orcha.palette
    val spans = remember(text) { MarkdownLite.inline(text) }
    return buildAnnotatedString {
        spans.forEach { s ->
            when {
                s.link != null -> withLink(
                    LinkAnnotation.Url(s.link, TextLinkStyles(style = SpanStyle(color = p.accent))),
                ) { append(s.text) }
                s.code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = p.text, background = p.surface2)) { append(s.text) }
                else -> withStyle(
                    SpanStyle(
                        fontWeight = if (s.bold) FontWeight.SemiBold else null,
                        fontStyle = if (s.italic) FontStyle.Italic else null,
                    ),
                ) { append(s.text) }
            }
        }
    }
}

/* ---------- properties + dependencies ---------- */

@Composable
private fun TaskPropertiesSection(
    task: TaskDto,
    agents: List<AgentDto>,
    routineText: String? = null,
    onPickReviewer: (() -> Unit)? = null,
) {
    val p = Orcha.palette
    LSection("Properties") {
        LCard(padding = 0.dp) {
            PropertyRow("Status") {
                LStatusGlyph(task.status, size = 13.dp)
                Text(MobileUx.statusCopy(task.status), style = ltype(LType.Meta), color = p.text)
            }
            LDivider()
            PropertyRow("Priority") {
                LPriorityGlyph(task.priority, size = 13.dp)
                Text("${priorityLabel(task.priority)} · P${task.priority ?: 100}", style = ltype(LType.Meta), color = p.text)
            }
            LDivider()
            PropertyRow("Assignee") {
                val a = task.assignees.firstOrNull() ?: task.ownerAlias
                if (a != null) {
                    LAvatar(a, isAI = isAiAlias(a, agents), size = 18.dp)
                    Text(a, style = ltype(LType.Meta), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else {
                    Text("Unassigned", style = ltype(LType.Meta), color = p.faint)
                }
            }
            LDivider()
            ReviewerPropertyRow(task, agents, onPickReviewer)
            routineText?.let {
                LDivider()
                PropertyRow("Routine") {
                    Icon(OrchaIcons.Schedule, null, tint = p.faint, modifier = Modifier.size(14.dp))
                    Text(it, style = ltype(LType.Meta), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            MobileUx.agoLabel(task.createdAt)?.let { created ->
                LDivider()
                PropertyRow("Created") { Text(created, style = ltype(LType.Meta), color = p.text2) }
            }
        }
    }
}

private enum class InsightSheetKind { Reassign, Reviewer, Recurring }

/** The reviewer's display name: the snapshot member for `reviewer_agent_id`, else the routed alias. */
private fun reviewerName(task: TaskDto, agents: List<AgentDto>): String? =
    task.reviewerAgentId?.let { id -> agents.firstOrNull { it.id == id }?.let { it.githubLogin ?: it.alias } }
        ?: task.reviewRouting?.reviewerAlias

/** iOS parity: "Reviewer" property; tappable (picker) for owners / members who may assign reviewers. */
@Composable
private fun ReviewerPropertyRow(task: TaskDto, agents: List<AgentDto>, onPick: (() -> Unit)?) {
    val p = Orcha.palette
    val name = task.reviewerAgentId?.let { id -> agents.firstOrNull { it.id == id }?.let { it.githubLogin ?: it.alias } ?: "Member" }
    PropertyRow(
        "Reviewer",
        modifier = if (onPick != null) {
            Modifier.clickable(role = Role.Button, onClickLabel = if (name == null) "Assign a reviewer" else "Change the reviewer", onClick = onPick)
        } else Modifier,
    ) {
        if (name != null) {
            LAvatar(name, isAI = false, size = 18.dp)
            Text(name, style = ltype(LType.Meta), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        } else {
            Text("Anyone", style = ltype(LType.Meta), color = p.faint)
        }
        if (onPick != null) Icon(OrchaIcons.ExpandMore, null, tint = p.faint, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun PropertyRow(label: String, modifier: Modifier = Modifier, value: @Composable RowScope.() -> Unit) {
    val p = Orcha.palette
    Row(
        modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = LSpace.m, vertical = 6.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Text(label, style = ltype(LType.Meta), color = p.faint, modifier = Modifier.widthIn(min = 96.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), content = value)
    }
}

@Composable
private fun DependenciesSection(dependsOn: List<String>, tasks: List<TaskDto>, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    LSection("Depends on", count = dependsOn.size) {
        LCard(padding = 0.dp) {
            dependsOn.forEachIndexed { index, depId ->
                val dep = tasks.firstOrNull { it.id == depId }
                if (index > 0) LDivider()
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenTask(depId) }.heightIn(min = 48.dp).padding(horizontal = LSpace.m, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    LStatusGlyph(dep?.status ?: "pending", size = 14.dp)
                    Text(dep?.title ?: depId, style = ltype(LType.Body), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(dep?.shortId ?: "", style = ltype(LType.Mono), color = p.faint)
                }
            }
        }
    }
}

/* ---------- activity + runs ---------- */

private data class ActivityEntry(
    val id: String,
    val sortKey: String,
    val time: String?,
    val actor: String?,
    val isAI: Boolean,
    val glyph: String?,
    val text: String,
    val isMessage: Boolean,
)

/** Rows the Activity pane lists (lifecycle + the latest [ACTIVITY_MESSAGE_LIMIT] messages); the tab count uses the same list. */
private const val ACTIVITY_MESSAGE_LIMIT = 8

private fun activityEntries(task: TaskDto, messages: List<TaskMessageDto>): List<ActivityEntry> = buildList {
    task.createdAt?.let { add(ActivityEntry("created", it, MobileUx.agoLabel(it), null, false, "pending", "Task created", false)) }
    task.startedAt?.let { add(ActivityEntry("started", it, MobileUx.agoLabel(it), null, false, "in_progress", "Work started", false)) }
    task.completedAt?.let {
        val cancelled = task.status == "cancelled"
        add(ActivityEntry("completed", it, MobileUx.agoLabel(it), null, false, if (cancelled) "cancelled" else "completed", if (cancelled) "Closed" else "Completed", false))
    }
    messages.takeLast(ACTIVITY_MESSAGE_LIMIT).forEachIndexed { i, m ->
        val author = m.authorAlias ?: if (m.isHuman) "you" else "system"
        add(ActivityEntry(m.messageId ?: "m$i", m.createdAt ?: "", MobileUx.agoLabel(m.createdAt), author, !m.isHuman && m.authorId != null, null, ActivityCopy.humanize(m.body), true))
    }
}.sortedBy { it.sortKey }

@Composable
private fun ActivityTimeline(task: TaskDto, messages: List<TaskMessageDto>, agents: List<AgentDto>, onOpenThread: () -> Unit) {
    val p = Orcha.palette
    val entries = remember(task, messages) { activityEntries(task, messages) }
    Column {
        if (messages.isNotEmpty()) {
            Text(
                if (messages.size > ACTIVITY_MESSAGE_LIMIT) "Show all ${messages.size} messages" else "Open thread",
                style = ltype(LType.Meta), color = p.accent,
                modifier = Modifier.clickable(onClick = onOpenThread).heightIn(min = 48.dp).padding(vertical = 14.dp),
            )
        }
        entries.forEach { e ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = LSpace.s).semantics(mergeDescendants = true) {},
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                    if (e.glyph != null) LStatusGlyph(e.glyph, size = 12.dp)
                    else LAvatar(e.actor ?: "?", isAI = e.isAI, size = 18.dp)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (e.actor != null) Text(e.actor, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
                        else Text(e.text, style = ltype(LType.Meta), color = p.text2, modifier = Modifier.weight(1f))
                        Text(e.time ?: "", style = ltype(LType.Micro), color = p.faint)
                    }
                    if (e.isMessage) {
                        Text(inlineMarkdown(e.text), style = ltype(LType.Body), color = p.text2, maxLines = 5, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        if (messages.isEmpty()) {
            Text("No comments yet. Say hi below.", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(top = LSpace.s))
        }
    }
}

@Composable
private fun RunsTimeline(runs: List<RunDto>, onOpenRun: (RunDto) -> Unit) {
    val p = Orcha.palette
    var showAll by remember { mutableStateOf(false) }
    Column {
        if (runs.isEmpty()) {
            Text("No runs yet. One appears when a worker wakes for this task.", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(top = LSpace.s))
        }
        (if (showAll) runs else runs.take(5)).forEach { run ->
            RunRow(run, onOpenRun)
            LDivider()
        }
        if (!showAll && runs.size > 5) {
            Text(
                "All runs (${runs.size})",
                style = ltype(LType.Meta), color = p.accent,
                modifier = Modifier.clickable { showAll = true }.heightIn(min = 48.dp).padding(vertical = 14.dp),
            )
        }
    }
}

/* ---------- bottom comment composer ---------- */

/** Linear composer: surface2 field + round accent send. Without a send handler it opens the thread. */
@Composable
internal fun TaskCommentComposer(
    assignee: String?,
    busy: Boolean,
    onSend: ((String) -> Unit)?,
    onOpenThread: () -> Unit,
    placeholder: String = "Leave a comment…",
    draftState: Pair<String, (String) -> Unit>? = null,
) {
    val p = Orcha.palette
    var localDraft by rememberSaveable { mutableStateOf("") }
    val draft = draftState?.first ?: localDraft
    val setDraft: (String) -> Unit = draftState?.second ?: { localDraft = it }
    val canSend = draft.isNotBlank() && !busy && onSend != null
    Column(Modifier.fillMaxWidth().background(p.surface).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
        LDivider()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = LSpace.m, vertical = LSpace.xs),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            val shape = RoundedCornerShape(10.dp)
            Box(
                Modifier
                    .weight(1f)
                    .padding(vertical = 4.dp)
                    .background(p.surface2, shape)
                    .border(1.dp, p.border, shape)
                    .then(if (onSend == null) Modifier.clickable(role = Role.Button, onClickLabel = "Open thread", onClick = onOpenThread) else Modifier)
                    .heightIn(min = 40.dp)
                    .padding(horizontal = LSpace.m, vertical = 9.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (onSend == null) {
                    Text(placeholder, style = ltype(LType.Body), color = p.faint)
                } else {
                    if (draft.isEmpty()) Text(placeholder, style = ltype(LType.Body), color = p.faint)
                    BasicTextField(
                        value = draft,
                        onValueChange = setDraft,
                        textStyle = ltype(LType.Body).copy(color = p.text),
                        cursorBrush = SolidColor(p.accent),
                        maxLines = 5,
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Comment to ${assignee ?: "the thread"}" },
                    )
                }
            }
            IconButton(
                onClick = {
                    if (onSend == null) onOpenThread() else {
                        val text = draft.trim()
                        if (text.isNotEmpty()) { setDraft(""); onSend(text) }
                    }
                },
                enabled = canSend || onSend == null,
            ) {
                Box(
                    Modifier.size(36.dp).background(if (canSend) p.lPrimaryFill else p.surface2, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(OrchaIcons.Send, "Send comment", tint = if (canSend) p.lPrimaryText else p.faint, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
