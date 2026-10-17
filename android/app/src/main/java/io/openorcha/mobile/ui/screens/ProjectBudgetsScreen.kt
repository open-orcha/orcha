package io.openorcha.mobile.ui.screens

/* Settings › Execution › Budgets & limits and Agent worktrees (web Settings › Execution).
   Owners and manage_autonomy holders edit (worktree settings and "Clean up now" too — the
   backend's SETTINGS_GRANT); everyone else reads. "Clean up now" files a request the host
   notifier carries out, then polls it every 2 s for up to 30 s (iOS AgentWorktreesScreen). */

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import io.openorcha.mobile.data.AgentWorktreesResponse
import io.openorcha.mobile.data.BudgetStatusDto
import io.openorcha.mobile.data.ProjectApi
import io.openorcha.mobile.data.ProjectBudgetsResponse
import io.openorcha.mobile.data.ProjectLimitsResponse
import io.openorcha.mobile.data.ProjectMembersResponse
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.WorktreeActionsApi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import io.openorcha.mobile.domain.MetricsFormat
import io.openorcha.mobile.domain.ProjectAuthority
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

@Composable
fun ProjectBudgetsScreen(container: StoredContainer, worktrees: Boolean, onBack: () -> Unit) {
    val p = Orcha.palette
    val base = container.baseUrl
    val actor = container.humanAgentId
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var members by remember { mutableStateOf<ProjectMembersResponse?>(null) }
    var limits by remember { mutableStateOf<ProjectLimitsResponse?>(null) }
    var budgets by remember { mutableStateOf<ProjectBudgetsResponse?>(null) }
    var wt by remember { mutableStateOf<AgentWorktreesResponse?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var usd by remember { mutableStateOf("") }
    var tokens by remember { mutableStateOf("") }
    var maxAgents by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    BackHandler(onBack = onBack)

    suspend fun load() {
        members = runCatching { ProjectApi.members(base, container.id) }.getOrNull()
        if (worktrees) {
            runCatching { ProjectApi.agentWorktrees(base, container.id) }
                .onSuccess { wt = it }.onFailure { loadError = routineErrorText(it) }
        } else {
            runCatching { ProjectApi.limits(base, container.id) }
                .onSuccess { limits = it; maxAgents = it.maxAutoAgents.toString() }
            runCatching { ProjectApi.budgets(base, container.id) }
                .onSuccess {
                    budgets = it
                    usd = it.project.limits.usd?.let { v -> if (v % 1.0 == 0.0) v.toLong().toString() else v.toString() }.orEmpty()
                    tokens = it.project.limits.tokens?.toString().orEmpty()
                }
                .onFailure { loadError = routineErrorText(it) }
        }
    }
    LaunchedEffect(container.id, worktrees) { load() }

    val canEdit = ProjectAuthority.can(members, actor)
    var confirmCleanup by remember { mutableStateOf(false) }
    val cleanCount = wt?.inventory?.counts?.get("clean") ?: 0

    fun save(what: String, block: suspend () -> Unit) {
        busy = true
        scope.launch {
            runCatching { block() }
                .onSuccess { snackbar.showSnackbar("$what saved."); load() }
                .onFailure { snackbar.showSnackbar("Couldn't save — " + routineErrorText(it) + ".") }
            busy = false
        }
    }

    fun cleanUp() {
        busy = true
        scope.launch {
            runCatching { WorktreeActionsApi.cleanUpAndWait(base, container.id, actor) }
                .onSuccess { a ->
                    snackbar.showSnackbar(
                        when {
                            a.pending -> "Waiting for the notifier — it runs this as soon as it's back."
                            a.status == "failed" -> "Not done — " + (a.error ?: "the notifier couldn't do it") + "."
                            else -> "Clean-up done."
                        },
                    )
                    load()
                }
                .onFailure { if (it !is kotlinx.coroutines.CancellationException) snackbar.showSnackbar("Couldn't send that — " + routineErrorText(it) + ".") }
            busy = false
        }
    }

    if (confirmCleanup) {
        AlertDialog(
            onDismissRequest = { confirmCleanup = false },
            containerColor = p.surface,
            title = { Text("Clean up clean worktrees?", style = ltype(LType.Headline), color = p.text) },
            text = {
                Text(
                    "Only Embodent scaffolding is in them. The worktrees and their branches are removed. Worktrees with output or unmerged commits are left alone.",
                    style = ltype(LType.Body), color = p.text2,
                )
            },
            confirmButton = { TextButton(onClick = { confirmCleanup = false; cleanUp() }) { Text("Clean up $cleanCount", color = p.danger) } },
            dismissButton = { TextButton(onClick = { confirmCleanup = false }) { Text("Cancel", color = p.text2) } },
        )
    }

    Scaffold(
        containerColor = p.bg,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { LTopBar(title = if (worktrees) "Agent worktrees" else "Budgets & limits", onBack = onBack) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.xl),
        ) {
            loadError?.let { item { Text("Couldn't load — $it.", style = ltype(LType.Body), color = p.danger) } }
            if (!canEdit && members != null) {
                item {
                    Text(
                        if (worktrees) "Only the project owner or someone allowed to manage autonomy can change worktree clean-up." else "Only the project owner or someone allowed to manage autonomy can change budgets and the agent limit.",
                        style = ltype(LType.Meta), color = p.muted,
                    )
                }
            }
            if (worktrees) {
                wt?.let { w -> item { WorktreeSection(
                    w, canEdit && !busy,
                    onCleanUp = if (canEdit && cleanCount > 0) ({ confirmCleanup = true }) else null,
                    cleaning = busy,
                ) { auto, days ->
                    save("Worktree cleanup") { ProjectApi.setWorktreeSettings(base, container.id, actor, auto, days) }
                } } }
            } else {
                budgets?.let { b ->
                    item {
                        LSection("Project budget") {
                            LCard {
                                UsageLine(b.project, "This month")
                                if (b.project.paused) Text("Paused — the monthly limit was reached.", style = ltype(LType.Meta), color = p.danger)
                                if (canEdit) {
                                    OrchaField(usd, { usd = it.filter { c -> c.isDigit() || c == '.' } }, label = "Monthly limit (USD)", placeholder = "No limit", maxLines = 1)
                                    OrchaField(tokens, { tokens = it.filter(Char::isDigit) }, label = "Monthly limit (tokens)", placeholder = "No limit", maxLines = 1,
                                        supporting = "Leave blank for no limit. Agents stop starting new runs once a limit is reached.")
                                    LButton("Save budget", {
                                        save("Budget") { ProjectApi.setProjectBudget(base, container.id, actor, usd.toDoubleOrNull(), tokens.toLongOrNull()) }
                                    }, kind = LButtonKind.Primary, size = LSize.Small, enabled = !busy)
                                } else {
                                    Text(
                                        "Limit: " + listOfNotNull(b.project.limits.usd?.let(MetricsFormat::usd), b.project.limits.tokens?.let { MetricsFormat.tokens(it) + " tokens" })
                                            .ifEmpty { listOf("No limit") }.joinToString(" · "),
                                        style = ltype(LType.Body), color = p.text2,
                                    )
                                }
                            }
                        }
                    }
                    if (b.agents.isNotEmpty()) {
                        item {
                            LSection("Agents", count = b.agents.size) {
                                LCard {
                                    b.agents.forEachIndexed { i, a ->
                                        if (i > 0) LDivider(Modifier.padding(vertical = LSpace.xs))
                                        UsageLine(a, a.alias ?: "Agent")
                                    }
                                }
                                Text("Set an agent's own limit from its page.", style = ltype(LType.Meta), color = p.muted)
                            }
                        }
                    }
                }
                limits?.let { l ->
                    item {
                        LSection("Agent limit") {
                            LCard {
                                Text("${l.autoAgentsInUse} of ${l.maxAutoAgents} AI agents in use", style = ltype(LType.Body), color = p.text)
                                if (canEdit) {
                                    OrchaField(maxAgents, { maxAgents = it.filter(Char::isDigit).take(2) }, label = "Most AI agents at once", maxLines = 1,
                                        supporting = "Between ${l.minMaxAutoAgents} and ${l.maxMaxAutoAgents}.")
                                    val n = maxAgents.toIntOrNull()
                                    LButton("Save limit", {
                                        if (n != null) save("Agent limit") { ProjectApi.setLimits(base, container.id, actor!!, n) }
                                    }, kind = LButtonKind.Primary, size = LSize.Small,
                                        enabled = !busy && actor != null && n != null && n in l.minMaxAutoAgents..l.maxMaxAutoAgents)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UsageLine(s: BudgetStatusDto, label: String) {
    val p = Orcha.palette
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
        Text(label, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
        val spend = MetricsFormat.usd(s.usage.spendUsd) + (s.limits.usd?.let { " of " + MetricsFormat.usd(it) } ?: "")
        val tok = MetricsFormat.tokens(s.usage.tokens) + " tokens" + (s.limits.tokens?.let { " of " + MetricsFormat.tokens(it) } ?: "")
        Text("$spend · $tok", style = ltype(LType.Meta), color = if (s.paused) p.danger else p.text2)
    }
}

@Composable
private fun WorktreeSection(
    w: AgentWorktreesResponse,
    canEdit: Boolean,
    onCleanUp: (() -> Unit)? = null,
    cleaning: Boolean = false,
    onSave: (Boolean, Int) -> Unit,
) {
    val p = Orcha.palette
    var auto by remember(w) { mutableStateOf(w.settings.autoCleanup) }
    var days by remember(w) { mutableStateOf(w.settings.graceDays) }
    Column(verticalArrangement = Arrangement.spacedBy(LSpace.l)) {
        LSection("Cleanup") {
            LCard {
                ProjectCheckRow("Clean up merged worktrees automatically", auto, enabled = canEdit) { auto = it }
                Text("Keep a finished worktree for", style = ltype(LType.Meta), color = p.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(dp6)) {
                    listOf(0, 3, 7, 14, 30).forEach { d ->
                        LChip(if (d == 0) "No grace" else "$d days", selected = days == d, onClick = if (canEdit) ({ days = d }) else null)
                    }
                }
                if (canEdit) {
                    LButton("Save", { onSave(auto, days) }, kind = LButtonKind.Primary, size = LSize.Small,
                        enabled = auto != w.settings.autoCleanup || days != w.settings.graceDays)
                }
            }
        }
        w.inventory?.let { inv ->
            LSection("On this host") {
                LCard {
                    Text(inv.host ?: "The notifier's host", style = ltype(LType.BodyEmph), color = p.text)
                    Text(
                        "${inv.counts.values.sum()} worktrees · ${MetricsFormat.bytes(inv.totalBytes)} · ${MetricsFormat.bytes(inv.reclaimableBytes)} reclaimable",
                        style = ltype(LType.Meta), color = p.text2,
                    )
                    if (onCleanUp != null) {
                        val clean = inv.counts["clean"] ?: 0
                        LButton(
                            if (cleaning) "Cleaning up…" else "Clean up now ($clean)", onCleanUp,
                            size = LSize.Small, enabled = !cleaning,
                        )
                    }
                    Text("Clean up individual worktrees from the portal.", style = ltype(LType.Meta), color = p.muted)
                }
            }
        }
    }
}

private val dp6 = androidx.compose.ui.unit.Dp(6f)
