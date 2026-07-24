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
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha
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
    // header
    item {
        OrchaCard(Modifier.alpha(if (dead) 0.55f else 1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(agent.alias, human = agent.kind == "human", size = AvatarSize.Lg)
                Column(Modifier.weight(1f)) {
                    Text(agent.alias, style = MaterialTheme.typography.titleLarge)
                    Text(agent.role ?: if (agent.kind == "human") "Human authority" else "agent", color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StatusPill(agent.status ?: agent.kind, StatusDomain.Agent)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                agent.model?.let { MetaTag(it, mono = true) }
                Spacer(Modifier.weight(1f))
                Text(MobileUx.agoLabel(agent.lastActive) ?: "", style = MonoSmStyle, color = p.faint)
            }
        }
    }
    if (agent.kind == "ai" && !dead) {
        item { PrimaryButton("Converse", { onConversation(agent.id) }, Modifier.fillMaxWidth()) }
    }
    // Now (flow 09 §4): live run's task wins over a stale current_task claim (GH #125/#126)
    val activeRun = agent.activeRun
    val nowTask = OrchaSelectors.nowTaskRef(agent)
    val nowTaskId = nowTask?.taskId
    val nowTaskTitle = nowTask?.title
    if (nowTaskId != null || activeRun != null) {
        item { SectionH("Now") }
        nowTaskId?.let { tid ->
            item {
                OrchaCard(onClick = { onOpenTask(tid) }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("▸", color = p.accent, fontWeight = FontWeight.W800)
                        Text(nowTaskTitle ?: tid, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        activeRun?.let { run ->
            item {
                OrchaCard(
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
                    borderColor = p.accentLine,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(run.runId.take(6), style = MonoStyle)
                        StatusPill("running", StatusDomain.Run)
                        MetaTag(run.wakeKind ?: "headless")
                        Spacer(Modifier.weight(1f))
                        Text("streaming", style = MaterialTheme.typography.labelMedium, color = p.accent, modifier = Modifier.alpha(pulseAlpha()))
                    }
                }
            }
        }
    }
    // Controls (flow 09 §5) — human-only; disabled once retired
    if (agent.kind == "ai") {
        item { SectionH("Controls", "human authority") }
        item {
            OrchaCard(Modifier.alpha(if (dead) 0.55f else 1f)) {
                Row(
                    Modifier.fillMaxWidth().let { if (!dead) it.clickable { onOpenModel() } else it },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Model", style = MaterialTheme.typography.titleSmall)
                        Text("Applies at the next wake", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    }
                    MetaTag(agent.model ?: "default", mono = true)
                }
                Row(
                    Modifier.fillMaxWidth().let { if (!dead) it.clickable { onOpenWake() } else it },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Auto-wake", style = MaterialTheme.typography.titleSmall)
                        Text("Clock-driven wakes while idle", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    }
                    MetaTag(agent.autoWakeIntervalSecs?.let { formatCadence(it) } ?: "Off")
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Wake daemon", style = MaterialTheme.typography.titleSmall)
                        Text("Managed from the laptop", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                    }
                    MetaTag(if (agent.wakeEnabled == false) "off" else "on")
                }
            }
        }
    }
    // persona — collapsed preview; expanding shows the full system prompt (flow 09 §6)
    val personaFull = state.agentExtras.persona?.systemPrompt
    val preview = agent.promptPreview ?: personaFull?.take(160)
    if (!preview.isNullOrBlank()) {
        item {
            SectionH("Persona", trailing = {
                if (!personaFull.isNullOrBlank()) Text(
                    if (personaOpen) "collapse" else "expand",
                    style = MaterialTheme.typography.labelMedium, color = p.accent,
                    modifier = Modifier.clickable { onTogglePersona() },
                )
            })
        }
        item {
            OrchaCard {
                if (personaOpen && !personaFull.isNullOrBlank()) {
                    Text(personaFull, color = p.text2, style = MonoSmStyle.copy(fontSize = 12.sp, lineHeight = 17.sp))
                } else {
                    Text(preview, color = p.text2, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    // memory digest (flow 09 §7)
    state.agentExtras.digest?.let { d ->
        item { SectionH("Memory", MobileUx.agoLabel(d.createdAt) ?: "") }
        item {
            OrchaCard {
                d.currentFocus?.takeIf { it.isNotBlank() }?.let {
                    Text("FOCUS", style = MaterialTheme.typography.labelMedium, color = p.accent)
                    Text(it, color = p.text, style = MaterialTheme.typography.bodyMedium)
                }
                if (d.decisions.isNotEmpty()) {
                    Text("DECISIONS · ${d.decisions.size}", style = MaterialTheme.typography.labelMedium, color = p.muted)
                    d.decisions.take(3).forEach { Text("• ${it.text}", color = p.text2, style = MaterialTheme.typography.bodyMedium) }
                }
                if (d.openThreads.isNotEmpty()) {
                    Text("OPEN THREADS · ${d.openThreads.size}", style = MaterialTheme.typography.labelMedium, color = p.muted)
                    d.openThreads.take(3).forEach { Text("• ${it.text}", color = p.text2, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
    }
    // requests summary rows (flow 09 §8)
    if (state.agentExtras.inboxCount != null || state.agentExtras.outboxOpen != null) {
        item { SectionH("Requests") }
        item {
            OrchaCard(onClick = onOpenRequests) {
                KVRow("Incoming open", "${state.agentExtras.inboxCount ?: 0}")
                state.agentExtras.inboxPreview?.let {
                    Text("“$it”", color = p.muted, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                KVRow("Outgoing open / answered", "${state.agentExtras.outboxOpen ?: 0} / ${state.agentExtras.outboxAnswered ?: 0}")
            }
        }
    }
    item { SectionH("Recent runs", "${state.agentRuns.size}") }
    if (state.agentRuns.isEmpty()) {
        item { OrchaCard { Text("No recent runs.", color = p.muted) } }
    }
    items(state.agentRuns.take(5), key = { it.runId }) { run ->
        RunRow(run.copy(agentId = run.agentId ?: agent.id, agentAlias = run.agentAlias ?: agent.alias), onOpenRun)
    }
    state.error?.let { item { Banner(BannerKind.Danger, it) } }
}
