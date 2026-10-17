package io.openorcha.mobile.ui.screens

/** Renders one agent-conversation turn (web/iOS chat layout) with task-link support. */

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.LinkifiedText
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.pulseAlpha
import io.openorcha.mobile.ui.components.pulsing
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 10 — Converse, chat like the web portal (mirrors ios Bubbles.swift):
   your messages right-aligned in a subtle surface2 bubble; agent turns left with no
   bubble — small avatar + name + time header, markdown body, "Work log" chip.
   ============================================================================= */

/**
 * Chat send-UX (iOS `ChatSendFlow` parity) — the composer's optimistic pending
 * bubble (sending / tap-to-retry / cleared-by-echo), the awaiting-reply indicator,
 * and the "no reply yet" overdue note. Rendered as `LazyListScope` items so they
 * slot in right after the loaded turns, before the composer.
 */
internal fun androidx.compose.foundation.lazy.LazyListScope.chatSendFlowItems(
    sendFlow: io.openorcha.mobile.domain.ChatSendFlow,
    agentAlias: String?,
    onRetry: () -> Unit,
    hideAwaiting: Boolean = false,
) {
    if (sendFlow.showsPendingBubble) {
        item(key = "pending-turn") {
            val p = Orcha.palette
            MineBubble(
                body = sendFlow.content,
                meta = when {
                    sendFlow.isFailed -> "Not sent · Tap to retry"
                    sendFlow.isSending -> "Sending…"
                    else -> null
                },
                metaColor = if (sendFlow.isFailed) p.danger else p.faint,
                onMetaClick = if (sendFlow.isFailed) onRetry else null,
            )
        }
    }
    if (sendFlow.showsAwaitingReply && !hideAwaiting) {
        item(key = "awaiting-reply") {
            Text(
                if (sendFlow.isFirstTurn) "Waking ${agentAlias ?: "the agent"} — a cold start can take a minute…" else "${agentAlias ?: "The agent"} is replying…",
                style = ltype(LType.Meta),
                color = Orcha.palette.muted,
                modifier = Modifier.pulsing(),
            )
        }
    }
    if (sendFlow.showsOverdueNote) {
        item(key = "reply-overdue") {
            Text("No reply yet — pull to refresh.", style = ltype(LType.Meta), color = Orcha.palette.muted)
        }
    }
}

/** Date separator: hairline — "Oct 2" — hairline. */
@Composable
internal fun ChatDateSeparator(label: String) {
    val p = Orcha.palette
    Row(
        Modifier.fillMaxWidth().padding(vertical = LSpace.s).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        LDivider(Modifier.weight(1f))
        Text(label, style = ltype(LType.Meta), color = p.muted)
        LDivider(Modifier.weight(1f))
    }
}

/** Your message: right-aligned subtle surface2 bubble, time (or send state) under it. */
@Composable
internal fun MineBubble(
    body: String,
    meta: String?,
    tasks: List<TaskDto> = emptyList(),
    onOpenTask: ((String) -> Unit)? = null,
    metaColor: androidx.compose.ui.graphics.Color = Orcha.palette.faint,
    onMetaClick: (() -> Unit)? = null,
) {
    val p = Orcha.palette
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.8f).dp
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Box(
            Modifier
                .widthIn(max = maxW)
                .background(p.surface2, shape)
                .border(1.dp, p.border, shape)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            LinkifiedText(body, tasks, onOpenTask, style = ltype(LType.Body), color = p.text)
        }
        meta?.let {
            Text(
                it,
                style = ltype(LType.Micro),
                color = metaColor,
                modifier = Modifier
                    .padding(top = 3.dp, end = 4.dp)
                    .let { m -> if (onMetaClick != null) m.clickable(role = Role.Button, onClick = onMetaClick).padding(vertical = 12.dp) else m },
            )
        }
    }
}

/** Agent turn: no bubble — avatar + name + time header, markdown body, optional Work log chip. */
@Composable
internal fun AgentTurn(
    alias: String,
    time: String?,
    body: String,
    tasks: List<TaskDto>,
    onOpenTask: (String) -> Unit,
    onWorkLog: (() -> Unit)?,
    workedFor: String? = null,
) {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier.semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            LAvatar(alias, isAI = true, size = 20.dp)
            Text(alias, style = ltype(LType.BodyEmph), color = p.text)
            time?.let { Text(it, style = ltype(LType.Meta), color = p.faint) }
        }
        MarkdownText(body, tasks = tasks, onOpenTask = onOpenTask)
        // iOS TurnFooter parity: "Worked for …" + the work-log link on one compact row
        if (workedFor != null || onWorkLog != null) {
            Row(
                Modifier.padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
            ) {
                workedFor?.let {
                    Row(
                        Modifier.semantics(mergeDescendants = true) {},
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        androidx.compose.material3.Icon(OrchaIcons.Schedule, null, tint = p.faint, modifier = Modifier.size(12.dp))
                        Text(it, style = ltype(LType.Micro), color = p.faint)
                    }
                }
                onWorkLog?.let { LChip("Work log ›", icon = OrchaIcons.Terminal, onClick = it) }
            }
        }
    }
}

@Composable
internal fun TurnBubble(
    turn: TurnDto,
    humanId: String?,
    agentAlias: String?,
    onOpenRun: (RunDto) -> Unit,
    agentId: String?,
    tasks: List<TaskDto>,
    onOpenTask: (String) -> Unit,
    workedFor: String? = null,
) {
    val p = Orcha.palette
    val mine = turn.authorAgentId == humanId || turn.role == "human"
    when {
        turn.role == "system" -> Text(
            turn.content,
            style = ltype(LType.Meta),
            color = p.muted,
            modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        mine -> MineBubble(turn.content, MobileUx.agoLabel(turn.createdAt), tasks, onOpenTask)
        else -> AgentTurn(
            alias = agentAlias ?: "agent",
            time = MobileUx.agoLabel(turn.createdAt),
            body = turn.content,
            tasks = tasks,
            onOpenTask = onOpenTask,
            onWorkLog = turn.runId?.let { rid -> { onOpenRun(RunDto(runId = rid, agentId = agentId, status = "exited")) } },
            workedFor = workedFor,
        )
    }
}
