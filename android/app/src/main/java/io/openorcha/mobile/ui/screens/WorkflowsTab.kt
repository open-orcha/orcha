package io.openorcha.mobile.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.WorkflowDetailDto
import io.openorcha.mobile.domain.WorkflowLogic
import io.openorcha.mobile.ui.WorkflowSupport
import io.openorcha.mobile.ui.WorkflowsController
import io.openorcha.mobile.ui.WorkflowsSegment
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSearchField
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Workflows tab (mobile design #373 §2, W01/W02): a Workflows | Tasks segment row; the
   Tasks segment is the former Tasks tab, unchanged. The Workflows segment shows the list
   with filters, owner, search and load more, every support/empty/stale state, and opens
   the workflow detail (WorkflowDetailScreen.kt) in place. */

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun WorkflowsTab(
    controller: WorkflowsController?,
    snapshot: ContainerSnapshot,
    container: StoredContainer?,
    onOpenTask: (String) -> Unit,
    onCreateTask: () -> Unit,
    onTaskChanged: () -> Unit,
) {
    if (controller == null) {
        TasksTab(snapshot.tasks, snapshot.agents, onOpenTask, container = container, onTaskChanged = onTaskChanged)
        return
    }
    LaunchedEffect(container?.id, container?.humanAgentId) { controller.bind(container) }
    val s by controller.state.collectAsState()
    var creating by remember { mutableStateOf(false) }

    if (creating) {
        WorkflowCreateScreen(
            controller = controller,
            agents = snapshot.agents,
            humanId = container?.humanAgentId,
            onClose = { creating = false },
            onSaved = { d -> creating = false; controller.openWorkflow(d.id) },
        )
        return
    }
    if (s.segment == WorkflowsSegment.Workflows && s.openWorkflowId != null) {
        WorkflowDetailScreen(controller = controller, snapshot = snapshot, onOpenTask = onOpenTask)
        return
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            PrimaryTabRow(selectedTabIndex = s.segment.ordinal, containerColor = Orcha.palette.bg, contentColor = Orcha.palette.text) {
                Tab(selected = s.segment == WorkflowsSegment.Workflows, onClick = { controller.selectSegment(WorkflowsSegment.Workflows) },
                    text = { Text("Workflows") })
                Tab(selected = s.segment == WorkflowsSegment.Tasks, onClick = { controller.selectSegment(WorkflowsSegment.Tasks) },
                    text = { Text("Tasks") })
            }
            when (s.segment) {
                WorkflowsSegment.Tasks -> TasksTab(snapshot.tasks, snapshot.agents, onOpenTask, container = container, onTaskChanged = onTaskChanged)
                WorkflowsSegment.Workflows -> WorkflowsList(controller, snapshot.agents)
            }
        }
        val canCreateWorkflow = s.segment == WorkflowsSegment.Workflows && s.support == WorkflowSupport.Supported
        if (canCreateWorkflow || s.segment == WorkflowsSegment.Tasks) {
            ExtendedFloatingActionButton(
                onClick = { if (canCreateWorkflow) creating = true else onCreateTask() },
                icon = { Icon(OrchaIcons.Add, null) },
                text = { Text(if (canCreateWorkflow) "New workflow" else "New task") },
                containerColor = Orcha.palette.accent,
                contentColor = Orcha.palette.accentInk,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkflowsList(controller: WorkflowsController, agents: List<AgentDto>) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    val nameOf = { id: String? -> agents.firstOrNull { it.id == id }?.alias }

    when (s.support) {
        WorkflowSupport.Checking -> {
            WorkflowSkeleton()
            return
        }
        WorkflowSupport.Unsupported -> {
            LEmptyState(
                OrchaIcons.Workflow, "This Orcha runs an older version without workflows",
                "Update Orcha on the laptop to use workflows here. Your tasks are unchanged.",
                actionTitle = "Open tasks", onAction = { controller.selectSegment(WorkflowsSegment.Tasks) },
            )
            return
        }
        WorkflowSupport.Forbidden -> {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Banner(BannerKind.Danger, s.supportMessage ?: "You do not have access to this project's workflows.")
                Text(
                    "Choose acting human: re-pair this phone as a current human member of the project (Settings → Containers).",
                    style = ltype(LType.Body), color = p.text2,
                )
                LButton("Try again", { controller.checkSupport() })
            }
            return
        }
        WorkflowSupport.Unreachable -> {
            LEmptyState(
                OrchaIcons.WifiOff, "Can't reach workflows",
                s.supportMessage ?: "The project didn't answer. Your work is safe on the laptop.",
                actionTitle = "Retry", onAction = { controller.checkSupport() },
            )
            return
        }
        WorkflowSupport.Supported -> Unit
    }

    if (s.hiddenOpen) {
        HiddenWorkflows(controller, nameOf)
        return
    }

    val counts = WorkflowLogic.counts(s.loaded)
    val shown = WorkflowLogic.visible(s.loaded, s.filter, s.query, s.ownerId)
    val owners = s.loaded.map { it.ownerHumanId }.distinct()
    var ownerMenu by remember { mutableStateOf(false) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "filters") {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WorkflowLogic.Filter.entries.forEach { f ->
                    FilterChip(
                        selected = s.filter == f,
                        onClick = { controller.setFilter(f) },
                        label = { Text("${f.label} ${counts[f] ?: 0}") },
                    )
                }
                if (s.capability != null) {
                    FilterChip(selected = false, onClick = { controller.openHidden(true) }, label = { Text("Hidden workflows") })
                }
            }
        }
        item(key = "search") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LSearchField(s.query, controller::setQuery, "Search loaded workflows", Modifier.weight(1f))
                Box {
                    IconButton(onClick = { ownerMenu = true }) {
                        Icon(OrchaIcons.Filter, "Owner filter", tint = if (s.ownerId != null) p.accent else p.text2)
                    }
                    DropdownMenu(expanded = ownerMenu, onDismissRequest = { ownerMenu = false }) {
                        DropdownMenuItem(text = { Text("Any owner") }, onClick = { controller.setOwner(null); ownerMenu = false })
                        owners.forEach { id ->
                            val name = nameOf(id) ?: "Unknown owner"
                            DropdownMenuItem(
                                leadingIcon = { LAvatar(name, size = 20.dp) },
                                text = { Text(name) },
                                onClick = { controller.setOwner(id); ownerMenu = false },
                            )
                        }
                    }
                }
            }
            Text(
                "${shown.size} of ${s.loaded.size} loaded" + if (s.nextCursor != null) " · more available" else "",
                style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(top = 4.dp),
            )
        }
        if (s.listStale) item(key = "stale") {
            Banner(
                BannerKind.Warn, "Showing the last loaded workflow data. Refresh before making changes.",
                action = "Retry", onAction = { controller.refreshList() },
            )
        }
        if (s.listLoading && s.loaded.isEmpty()) {
            item(key = "loading") { WorkflowSkeleton() }
        } else if (s.loaded.isEmpty()) {
            item(key = "empty") {
                LEmptyState(OrchaIcons.Workflow, "No workflows yet", "Create one to plan steps, loops and approvals for your agents.")
            }
        } else if (shown.isEmpty()) {
            item(key = "nomatch") {
                LEmptyState(OrchaIcons.Search, "No loaded workflows match these filters", "Search and owner filters apply to the loaded pages.")
            }
        } else if (s.filter == WorkflowLogic.Filter.All) {
            WorkflowLogic.grouped(shown).forEach { (label, rows) ->
                stickyHeader(key = "h:$label") {
                    Text(
                        "$label · ${rows.size}", style = ltype(LType.Meta), color = p.text2,
                        modifier = Modifier.fillMaxWidth().background(p.bg).padding(vertical = 6.dp).semantics { heading() },
                    )
                }
                items(rows, key = { it.id }) { w ->
                    WorkflowCard(w, nameOf(w.ownerHumanId), dim = s.listStale) { controller.openWorkflow(w.id) }
                }
            }
        } else {
            items(shown, key = { it.id }) { w ->
                WorkflowCard(w, nameOf(w.ownerHumanId), dim = s.listStale) { controller.openWorkflow(w.id) }
            }
        }
        if (s.nextCursor != null) item(key = "more") {
            LButton(
                if (s.loadingMore) "Loading…" else "Load more", { controller.loadMore() },
                Modifier.fillMaxWidth(), kind = LButtonKind.Secondary, enabled = !s.loadingMore,
            )
        }
    }
}

/** W01 card: glyph + server label · title · goal · chips · progress · owner · age. */
@Composable
internal fun WorkflowCard(w: WorkflowDetailDto, ownerName: String?, dim: Boolean = false, onClick: () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusCard.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(shape)
            .background(p.surface, shape)
            .clickable(onClick = onClick)
            .alpha(if (dim) 0.6f else 1f)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LStatusGlyph(WorkflowLogic.glyphStatus(w))
            Text(WorkflowLogic.workflowLabel(w), style = ltype(LType.Meta), color = p.text2)
            Spacer(Modifier.weight(1f))
            ownerName?.let { LAvatar(it, size = 20.dp) }
            Text(relativeAge(w.createdAt), style = ltype(LType.Meta), color = p.muted)
        }
        Text(w.title, style = ltype(LType.BodyEmph), color = p.text)
        if (w.goal.isNotBlank()) {
            Text(w.goal, style = ltype(LType.Body), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LTag(WorkflowLogic.modeLabel(w.executionMode))
            w.completion.blockers.firstOrNull()?.let { LTag(it.message, tint = p.warn) }
            WorkflowLogic.runningRound(w)?.let { LTag(it, tint = p.info) }
            WorkflowLogic.decisionChip(w)?.let { LTag(it, tint = p.warn) }
        }
        WorkflowProgress(w)
    }
}

@Composable
internal fun WorkflowProgress(w: WorkflowDetailDto) {
    val p = Orcha.palette
    if (w.progress.total == 0) {
        Text("No tasks yet", style = ltype(LType.Meta), color = p.muted)
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LinearProgressIndicator(
            progress = { w.progress.accepted.toFloat() / w.progress.total.coerceAtLeast(1) },
            modifier = Modifier.weight(1f).height(4.dp),
            color = p.ok,
            trackColor = p.surface2,
        )
        Text("${w.progress.accepted}/${w.progress.total}", style = ltype(LType.Meta), color = p.text2)
    }
}

@Composable
private fun HiddenWorkflows(controller: WorkflowsController, nameOf: (String?) -> String?) {
    val p = Orcha.palette
    val s by controller.state.collectAsState()
    BackHandler { controller.openHidden(false) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { controller.openHidden(false) }) { Icon(OrchaIcons.ArrowBack, "Back to workflows") }
                Text("Hidden workflows", style = ltype(LType.Headline), color = p.text)
            }
        }
        if (s.hiddenLoading && s.hidden.isEmpty()) item { WorkflowSkeleton() }
        else if (s.hidden.isEmpty()) item { LEmptyState(OrchaIcons.RemoveRedEye, "No hidden workflows", "Hidden workflows appear here with Restore.") }
        items(s.hidden, key = { it.id }) { w ->
            Column(
                Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(p.radiusCard.dp)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(w.title, style = ltype(LType.BodyEmph), color = p.text)
                Text("Was ${WorkflowLogic.workflowLabel(w)}", style = ltype(LType.Meta), color = p.text2)
                Text(
                    "Hidden by ${w.hiddenByAlias ?: nameOf(w.hiddenByHumanId) ?: "someone"} · ${relativeAge(w.hiddenAt)}",
                    style = ltype(LType.Meta), color = p.muted,
                )
                val reason = WorkflowLogic.actionReason(w, "restore", controller.hasHuman)
                LButton(
                    "Restore", { controller.restoreHidden(w.id) },
                    enabled = reason == null && !controller.busy, kind = LButtonKind.Secondary,
                )
                reason?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
            }
        }
    }
}

@Composable
internal fun WorkflowSkeleton() {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(3) {
            Box(Modifier.fillMaxWidth().height(72.dp).background(p.surface2, RoundedCornerShape(p.radiusCard.dp)))
        }
    }
}

/** "3h", "2d" from an ISO timestamp; empty when unknown. */
internal fun relativeAge(iso: String?): String {
    val then = iso?.let { runCatching { java.time.OffsetDateTime.parse(it).toInstant() }.getOrNull() } ?: return ""
    val mins = java.time.Duration.between(then, java.time.Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
        mins < 1 -> "now"
        mins < 60 -> "${mins}m"
        mins < 60 * 24 -> "${mins / 60}h"
        else -> "${mins / (60 * 24)}d"
    }
}
