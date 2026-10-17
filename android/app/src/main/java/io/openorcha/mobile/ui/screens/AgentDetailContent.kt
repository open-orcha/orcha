package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.KVRow
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.pulseAlpha
import io.openorcha.mobile.ui.components.pulsing
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.OrchaPalette

/** Builds the identity, activity, controls, memory, requests, and runs sections of agent detail. */
internal fun LazyListScope.AgentDetailContent(
    state: OrchaUiState,
    agent: AgentDto,
    dead: Boolean,
    palette: OrchaPalette,
    personaOpen: Boolean,
    onTogglePersona: () -> Unit,
    onOpenModel: () -> Unit,
    onOpenWake: () -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenRun: (RunDto) -> Unit,
    onOpenRequests: () -> Unit,
    onConversation: (String) -> Unit,
    onOpenAgent: ((String) -> Unit)? = null,
    onOpenHistory: (() -> Unit)? = null,
    canManageAgents: Boolean = true,
    canManageAutonomy: Boolean = true,
) {
    val p = palette
    if (dead) {
        item { Banner(BannerKind.Danger, "Retired${MobileUx.agoLabel(agent.terminatedAt)?.let { " $it" } ?: ""} — this agent no longer wakes.") }
    }
    // flow 09 §1: gate callout parity for this agent's tasks
    val gated = state.snapshot?.tasks.orEmpty().filter { t ->
        (t.assignees.contains(agent.alias) || t.ownerAlias == agent.alias) &&
            (t.status == "needs_verification" || (t.status == "in_progress" && t.planMessage != null && t.planDecision == null))
    }
    items(gated, key = { "gate-${it.id}" }) { t ->
        Banner(
            if (t.status == "needs_verification") BannerKind.Info else BannerKind.Warn,
            if (t.status == "needs_verification") "Task awaiting your verification: ${t.title}" else "Plan awaiting your approval: ${t.title}",
            action = "Open",
            onAction = { onOpenTask(t.id) },
        )
    }
    // header card — avatar (✦ + presence), name, role, status capsule
    item(key = "agent-head") {
        val status = if (dead) "retired" else agent.status ?: if (agent.kind == "human") "idle" else "idle"
        LCard(Modifier.alpha(if (dead) 0.55f else 1f), padding = LSpace.l) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
                LAvatar(agent.alias, isAI = agent.kind == "ai", size = 44.dp, status = if (agent.kind == "ai") status else null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        agent.alias, style = ltype(LType.Title), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        agent.role ?: if (agent.kind == "human") "Human authority" else "agent",
                        style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                if (agent.kind == "ai") AgentStatusCapsule(status)
            }
        }
    }
    if (agent.model != null || agent.lastActive != null) {
        item(key = "agent-meta") {
            LCard(padding = LSpace.l) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    agent.model?.let { io.openorcha.mobile.ui.components.ModelTag(it) }
                    Spacer(Modifier.weight(1f))
                    MobileUx.agoLabel(agent.lastActive)?.let { Text("Active $it", style = ltype(LType.Meta), color = p.faint) }
                }
            }
        }
    }
    if (agent.kind == "ai" && !dead) {
        item(key = "agent-converse") {
            LButton("Converse", { onConversation(agent.id) }, Modifier.fillMaxWidth(), icon = OrchaIcons.Forum, kind = LButtonKind.Primary)
        }
    }
    // Now (flow 09 §4): live run's task wins over a stale current_task claim (GH #125/#126)
    val activeRun = agent.activeRun
    val nowTask = OrchaSelectors.nowTaskRef(agent)
    val nowTaskId = nowTask?.taskId
    val nowTaskTitle = nowTask?.title
    if (nowTaskId != null || activeRun != null) {
        item(key = "agent-now") {
            LSection("Now") {
                LCard(padding = 0.dp) {
                    nowTaskId?.let { tid ->
                        LRow(
                            title = nowTaskTitle ?: tid,
                            onClick = { onOpenTask(tid) },
                            leading = { LStatusGlyph("in_progress") },
                            trailing = { Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp)) },
                        )
                    }
                    if (nowTaskId != null && activeRun != null) LDivider(inset = LSpace.m)
                    activeRun?.let { run ->
                        LRow(
                            title = "Run ${run.runId.take(6)}",
                            subtitle = listOfNotNull(ActivityCopy.humanizeKind(run.wakeKind ?: "headless"), run.runtime).joinToString(" · "),
                            onClick = {
                                onOpenRun(
                                    RunDto(
                                        runId = run.runId,
                                        agentId = agent.id,
                                        agentAlias = agent.alias,
                                        taskId = run.taskId,
                                        taskTitle = run.taskTitle,
                                        status = "running",
                                        wakeKind = run.wakeKind,
                                        wakeEvent = run.wakeEvent,
                                        runtime = run.runtime,
                                        startedAt = run.startedAt,
                                    ),
                                )
                            },
                            leading = { LStatusGlyph("running") },
                            trailing = {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                                    io.openorcha.mobile.ui.components.ModelProviderMark(run.runtime)
                                    Text("Streaming", style = ltype(LType.Meta), color = p.accent, modifier = Modifier.pulsing())
                                }
                            },
                        )
                    }
                }
            }
        }
    }
    // Controls (flow 09 §5) — human-only; disabled once retired
    if (agent.kind == "ai") {
        item(key = "agent-controls") {
            LSection("Controls", trailing = { Text("human authority", style = ltype(LType.Meta), color = p.faint) }) {
                LCard(Modifier.alpha(if (dead) 0.55f else 1f), padding = 0.dp) {
                    LRow(
                        title = "Model",
                        subtitle = "Applies at the next wake",
                        onClick = if (dead) null else onOpenModel,
                        trailing = { io.openorcha.mobile.ui.components.ModelTag(agent.model) },
                    )
                    LDivider(inset = LSpace.m)
                    LRow(
                        title = "Auto-wake",
                        subtitle = "Clock-driven wakes while idle",
                        onClick = if (dead) null else onOpenWake,
                        trailing = { LTag(agent.autoWakeIntervalSecs?.let { formatCadence(it) } ?: "Off") },
                    )
                    LDivider(inset = LSpace.m)
                    if (onOpenHistory != null) {
                        LRow(
                            title = "History",
                            subtitle = "Who changed which setting, and restore",
                            onClick = onOpenHistory,
                            trailing = { Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp)) },
                        )
                        LDivider(inset = LSpace.m)
                    }
                    LRow(
                        title = "Wake daemon",
                        subtitle = "Managed from the laptop",
                        trailing = { LTag(if (agent.wakeEnabled == false) "Off" else "On", tint = if (agent.wakeEnabled == false) null else p.ok, dot = true) },
                    )
                }
            }
        }
    }
    // Budget (month spend vs limit, hard stop, one-time override) + org chart line
    val baseUrl = state.selectedContainer?.baseUrl
    if (baseUrl != null && agent.kind == "ai" && !dead) {
        item(key = "agent-budget") {
            val me = state.selectedContainer?.humanAgentId
            val myRole = state.snapshot?.agents?.firstOrNull { it.id == me }?.memberRole
            AgentBudgetSection(baseUrl, agent.id, agent.alias, actorId = me, memberRole = myRole, canEditLimits = canManageAutonomy)
        }
    }
    if (baseUrl != null) {
        item(key = "agent-reports-to") {
            AgentReportsToSection(
                baseUrl, agent.id, onOpenAgent,
                alias = agent.alias,
                people = state.snapshot?.agents.orEmpty(),
                containerId = state.selectedContainer?.id,
                actorId = if (canManageAgents && agent.kind == "ai" && !dead) state.selectedContainer?.humanAgentId else null,
            )
        }
    }
    // persona — collapsed preview; expanding shows the full system prompt (flow 09 §6)
    val personaFull = state.agentExtras.persona?.systemPrompt
    val preview = agent.promptPreview ?: personaFull?.take(160)
    if (!preview.isNullOrBlank()) {
        item(key = "agent-persona") {
            LSection(
                "Persona",
                trailing = if (personaFull.isNullOrBlank()) null else {
                    {
                        LButton(if (personaOpen) "Collapse" else "Expand", onTogglePersona, kind = LButtonKind.Ghost, size = LSize.Small)
                    }
                },
            ) {
                LCard(padding = LSpace.l) {
                    if (personaOpen && !personaFull.isNullOrBlank()) {
                        Text(personaFull, color = p.text2, style = ltype(LType.Mono))
                    } else {
                        Text(preview, color = p.text2, style = ltype(LType.Body), maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
    // memory digest (flow 09 §7)
    state.agentExtras.digest?.let { d ->
        item(key = "agent-memory") {
            LSection("Memory", trailing = MobileUx.agoLabel(d.createdAt)?.let { ago -> { Text(ago, style = ltype(LType.Meta), color = p.faint) } }) {
                LCard(padding = LSpace.l) {
                    Column(verticalArrangement = Arrangement.spacedBy(LSpace.xs)) {
                        d.currentFocus?.takeIf { it.isNotBlank() }?.let {
                            Text("Focus", style = ltype(LType.Micro), color = p.muted)
                            Text(it, color = p.text, style = ltype(LType.Body))
                        }
                        if (d.decisions.isNotEmpty()) {
                            Text("Decisions · ${d.decisions.size}", style = ltype(LType.Micro), color = p.muted, modifier = Modifier.padding(top = LSpace.xs))
                            d.decisions.take(3).forEach { Text("• ${it.text}", color = p.text2, style = ltype(LType.Meta)) }
                        }
                        if (d.openThreads.isNotEmpty()) {
                            Text("Open threads · ${d.openThreads.size}", style = ltype(LType.Micro), color = p.muted, modifier = Modifier.padding(top = LSpace.xs))
                            d.openThreads.take(3).forEach { Text("• ${it.text}", color = p.text2, style = ltype(LType.Meta)) }
                        }
                    }
                }
            }
        }
    }
    // requests summary rows (flow 09 §8)
    if (state.agentExtras.inboxCount != null || state.agentExtras.outboxOpen != null) {
        item(key = "agent-requests") {
            LSection("Requests") {
                LCard(padding = 0.dp) {
                    LRow(
                        title = "Incoming open",
                        subtitle = state.agentExtras.inboxPreview?.let { "“$it”" },
                        onClick = onOpenRequests,
                        trailing = { Text("${state.agentExtras.inboxCount ?: 0}", style = ltype(LType.BodyEmph), color = p.text) },
                    )
                    LDivider(inset = LSpace.m)
                    LRow(
                        title = "Outgoing open / answered",
                        onClick = onOpenRequests,
                        trailing = {
                            Text(
                                "${state.agentExtras.outboxOpen ?: 0} / ${state.agentExtras.outboxAnswered ?: 0}",
                                style = ltype(LType.BodyEmph), color = p.text,
                            )
                        },
                    )
                }
            }
        }
    }
    item(key = "agent-runs-head") {
        LSection("Recent runs", count = state.agentRuns.size) {
            if (state.agentRuns.isEmpty()) Text("No recent runs.", style = ltype(LType.Meta), color = p.muted)
        }
    }
    items(state.agentRuns.take(5), key = { it.runId }) { run ->
        RunRow(run.copy(agentId = run.agentId ?: agent.id, agentAlias = run.agentAlias ?: agent.alias), onOpenRun)
    }
    state.error?.let { item { Banner(BannerKind.Danger, it) } }
}
