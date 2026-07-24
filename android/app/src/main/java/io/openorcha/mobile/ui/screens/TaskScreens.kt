package io.openorcha.mobile.ui.screens

/** Owns task detail presentation and its approval and close entry points. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.FeedRow
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
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
) {
    val p = Orcha.palette
    val task = state.selectedTask
    var menuOpen by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var closeReason by remember { mutableStateOf("") }
    var showVerify by remember { mutableStateOf(false) }
    var showPlan by remember { mutableStateOf(false) }
    var allRuns by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text(task?.title ?: "Task", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = onRefresh) { Icon(Icons.Rounded.Refresh, "Refresh") }
                    val closable = task != null && !task.isRoot && task.status !in setOf("completed", "cancelled")
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Close task…", color = if (closable) p.danger else p.faint) },
                            enabled = closable,
                            onClick = { menuOpen = false; onPrepareClose(); closing = true },
                        )
                    }
                },
            )
        },
    ) { padding ->
        if (task == null) {
            OrchaCard(Modifier.padding(padding).padding(16.dp)) { Text("Task not found — refresh the workspace.", color = p.muted) }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                OrchaCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusPill(task.status, StatusDomain.Task)
                        MetaTag("P${task.priority ?: 100}")
                        if (task.isRoot) MetaTag("root")
                    }
                    Text(task.title, style = MaterialTheme.typography.titleLarge)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val assignee = task.assignees.firstOrNull() ?: task.ownerAlias
                        if (assignee != null) {
                            Avatar(assignee, human = false, size = AvatarSize.Sm)
                            Text(assignee, style = MaterialTheme.typography.bodyMedium, color = p.text2)
                        } else Text("unassigned", style = MaterialTheme.typography.bodyMedium, color = p.faint)
                    }
                }
            }
            // flow 08 entry points — violet gate cards opening the approval sheets
            if (task.status == "needs_verification") {
                item {
                    OrchaCard(borderColor = p.violetLine) {
                        Text("AWAITING YOUR VERIFICATION", style = MaterialTheme.typography.labelMedium, color = p.violet)
                        Text(task.result ?: "The agent marked this done — review against the definition of done.", color = p.text2, maxLines = 4, overflow = TextOverflow.Ellipsis)
                        PrimaryButton("Review & verify", { showVerify = true }, Modifier.fillMaxWidth(), small = true)
                    }
                }
            }
            if (task.planMessage != null && task.planDecision == null && task.status == "in_progress") {
                item {
                    OrchaCard(borderColor = p.violetLine) {
                        Text("PLAN AWAITING YOUR APPROVAL", style = MaterialTheme.typography.labelMedium, color = p.violet)
                        Text(task.planMessage.body, color = p.text2, maxLines = 4, overflow = TextOverflow.Ellipsis)
                        PrimaryButton("Review plan", { showPlan = true }, Modifier.fillMaxWidth(), small = true)
                    }
                }
            }
            task.description?.takeIf { it.isNotBlank() }?.let {
                item { SectionH("Description") }
                item { OrchaCard { Text(it, color = p.text2) } }
            }
            item { SectionH("Definition of done") }
            item {
                OrchaCard(borderColor = p.accentLine, container = p.surface2) {
                    (task.definitionOfDone ?: "No definition of done was provided.").split("\n").filter { it.isNotBlank() }.forEach {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("✓", color = p.accent, fontWeight = FontWeight.W800)
                            Text(it.trim(), color = p.text)
                        }
                    }
                }
            }
            if (task.dependsOn.isNotEmpty()) {
                item { SectionH("Depends on", "${task.dependsOn.size}") }
                items(task.dependsOn, key = { "dep-$it" }) { depId ->
                    val dep = state.snapshot?.tasks?.firstOrNull { it.id == depId }
                    OrchaCard(onClick = { onOpenTask(depId) }) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(if (dep?.status == "completed") "✓" else "🔒", color = if (dep?.status == "completed") p.ok else p.warn)
                            Text(dep?.title ?: depId, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            dep?.let { StatusPill(it.status, StatusDomain.Task) }
                        }
                    }
                }
            }
            item { SectionH("Thread", "${state.taskMessages.size}") }
            item {
                OrchaCard(onClick = onOpenThread) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("Thread · ${state.taskMessages.size} messages", style = MaterialTheme.typography.titleSmall)
                            state.taskMessages.lastOrNull()?.let {
                                Text("${it.authorAlias ?: if (it.isHuman) "you" else "agent"}: ${it.body}", style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            } ?: Text("No messages yet — say hi.", style = MaterialTheme.typography.bodyMedium, color = p.faint)
                        }
                        Icon(Icons.Rounded.ChevronRight, null, tint = p.faint)
                    }
                }
            }
            item {
                SectionH("Worker runs", "${state.taskRuns.size}", trailing = {
                    if (state.taskRuns.any { it.status == "running" }) StatusPill("running", StatusDomain.Run)
                })
            }
            if (state.taskRuns.isEmpty()) {
                item { OrchaCard { Text("No runs yet — appears when a worker wakes for this task.", color = p.muted) } }
            }
            val visibleRuns = if (allRuns) state.taskRuns else state.taskRuns.take(3)
            items(visibleRuns, key = { it.runId }) { run -> RunRow(run, onOpenRun) }
            if (!allRuns && state.taskRuns.size > 3) {
                item {
                    TextButton(onClick = { allRuns = true }) {
                        Text("All runs (${state.taskRuns.size})", color = p.accent, fontWeight = FontWeight.W700)
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
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
        VerifySheet(task, state.actionInFlight, onDismiss = { showVerify = false }) { approve, feedback ->
            showVerify = false; onVerify(approve, feedback)
        }
    }
    if (showPlan && task != null) {
        PlanApprovalSheet(task, state.actionInFlight, onDismiss = { showPlan = false }) { approve, reason ->
            showPlan = false; onDecidePlan(approve, reason)
        }
    }
}
