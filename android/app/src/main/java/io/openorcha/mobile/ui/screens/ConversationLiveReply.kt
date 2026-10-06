package io.openorcha.mobile.ui.screens

/**
 * Chat live reply (web Conversation.tsx `LiveTurn` parity): while a reply is in flight,
 * find the agent's running conversation run and stream its output over the run SSE —
 * "Working · 12s", the current step, and the reply text as it is written. When the run
 * ends the block freezes as "Worked for …" and asks for a refresh so the durable turn
 * lands. The send flow's turns poll keeps running underneath as the fallback.
 */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunStreamEvent
import io.openorcha.mobile.data.getChatRuns
import io.openorcha.mobile.domain.AgentInsights
import io.openorcha.mobile.domain.RunFeed
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.pulsing
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive

/** Max streamed characters kept on screen (the durable turn replaces it anyway). */
private const val LIVE_TEXT_CAP = 4_000

@Stable
internal class ChatLiveReplyState {
    var runId by mutableStateOf<String?>(null)
    var startedAtMs by mutableLongStateOf(0L)
    var endedAtMs by mutableLongStateOf(0L)
    var text by mutableStateOf("")
    var step by mutableStateOf<String?>(null)
    var endStatus by mutableStateOf<String?>(null)

    /** A live (or just-finished) run is on screen: the plain "is replying…" line hides. */
    val showing: Boolean get() = runId != null

    fun reset() {
        runId = null; startedAtMs = 0L; endedAtMs = 0L; text = ""; step = null; endStatus = null
    }
}

/**
 * Drives [ChatLiveReplyState] while [active]: polls the agent's runs every 2s for a running
 * run that answers this conversation, then streams it (seq-deduped; reconnects on a drop).
 */
@Composable
internal fun rememberChatLiveReply(
    baseUrl: String?,
    agentId: String?,
    conversationId: String?,
    active: Boolean,
    onRunEnded: () -> Unit,
): ChatLiveReplyState {
    val state = remember(agentId) { ChatLiveReplyState() }
    val ended by rememberUpdatedState(onRunEnded)
    LaunchedEffect(baseUrl, agentId, conversationId, active) {
        if (!active || baseUrl == null || agentId == null) {
            state.reset()
            return@LaunchedEffect
        }
        val api = AgentSliceStore.api
        while (currentCoroutineContext().isActive && state.endStatus == null) {
            val run = runCatching { api.getChatRuns(baseUrl, agentId).runs }.getOrNull()
                ?.firstOrNull { it.status == "running" && it.answers(conversationId) }
            if (run == null) {
                delay(2_000)
                continue
            }
            if (state.runId != run.runId) {
                state.reset()
                state.runId = run.runId
                state.startedAtMs = AgentInsights.parseInstant(run.startedAt)?.toEpochMilli() ?: System.currentTimeMillis()
            }
            var maxSeq = 0
            var done: RunStreamEvent.Done? = null
            runCatching {
                api.streamRun(baseUrl, agentId, run.runId).collect { ev ->
                    when (ev) {
                        is RunStreamEvent.Line -> if (ev.seq > maxSeq) {
                            maxSeq = ev.seq
                            RunFeed.classifyLine(ev.line).forEach { row ->
                                when (row.type) {
                                    "narrate" -> if (row.label == "narration" && row.text.isNotBlank()) {
                                        state.text = row.text.takeLast(LIVE_TEXT_CAP)
                                        state.step = null
                                    }
                                    "tool" -> state.step = "Using ${row.text}"
                                    "think" -> state.step = "Thinking"
                                }
                            }
                        }
                        is RunStreamEvent.Done -> done = ev
                    }
                }
            }
            currentCoroutineContext().ensureActive()
            val d = done
            when {
                d != null && d.status == "stream_timeout" -> Unit // server cap: reopen
                d != null -> {
                    state.endStatus = d.status ?: "exited"
                    state.endedAtMs = System.currentTimeMillis()
                    state.step = null
                    ended()
                }
                else -> delay(2_000) // dropped: re-find the run and resume (polling covers the gap)
            }
        }
    }
    return state
}

@Composable
internal fun ChatLiveReplyBlock(state: ChatLiveReplyState, alias: String) {
    val p = Orcha.palette
    if (!state.showing) return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val live = state.endStatus == null
    LaunchedEffect(live) {
        while (live) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val end = if (live) now else state.endedAtMs
    val secs = ((end - state.startedAtMs) / 1000).coerceAtLeast(0)
    val headline = when {
        live -> "Working · ${AgentInsights.elapsedLabel(secs)}"
        state.endStatus in setOf("failed", "error", "crashed", "timeout", "timed_out") ->
            "Failed after ${AgentInsights.elapsedLabel(secs)}"
        state.endStatus in setOf("stopped", "killed", "cancelled") -> "Stopped after ${AgentInsights.elapsedLabel(secs)}"
        else -> AgentInsights.workedForLabel(secs.toDouble()) ?: "Worked"
    }
    Column(
        Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            LAvatar(alias, isAI = true, size = 20.dp, status = if (live) "working" else null)
            Text(alias, style = ltype(LType.BodyEmph), color = p.text)
            Icon(OrchaIcons.Schedule, null, tint = p.faint, modifier = Modifier.size(12.dp))
            Text(
                headline,
                style = ltype(LType.Meta),
                color = if (live) p.accent else p.faint,
                modifier = if (live) Modifier.pulsing() else Modifier,
            )
        }
        state.step?.takeIf { live }?.let { Text(it, style = ltype(LType.Meta), color = p.muted, maxLines = 1) }
        if (state.text.isNotBlank()) MarkdownText(state.text)
    }
}
