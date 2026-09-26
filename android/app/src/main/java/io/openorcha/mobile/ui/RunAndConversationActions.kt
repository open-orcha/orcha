package io.openorcha.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.ContainerSnapshot
import io.openorcha.mobile.data.ContainerStore
import io.openorcha.mobile.data.ConversationDto
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.OrchaServerAddress
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.RunStream
import io.openorcha.mobile.data.RunStreamEvent
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.Paging
import io.openorcha.mobile.domain.RunFeed
import io.openorcha.mobile.domain.RunFeedRow
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Owns worker-run streaming and agent conversation refresh. */
internal interface RunAndConversationActions : OrchaViewModelAccess {
fun openRun(run: RunDto) {
    cancelRunStream()
    _uiState.update { it.copy(route = AppRoute.RunDetail, selectedRun = run, runFeed = emptyList(), runStreamNote = null, error = null) }
    refreshRunLog()
}

/**
 * Issue 3: a RUNNING run gets a live collector on the same SSE endpoint the web
 * streams (incremental read, per-request infinite timeout); a finished run keeps
 * the one-shot fetch (the server closes those streams immediately).
 */
override fun refreshRunLog() {
    val selected = _uiState.value.selectedContainer ?: return
    val run = _uiState.value.selectedRun ?: return
    val agentId = run.agentId ?: _uiState.value.selectedAgent?.id ?: return
    cancelRunStream()
    if (run.status == "running") {
        _uiState.update { it.copy(loading = false, error = null, runStreamNote = null, runFeed = emptyList()) }
        runStreamJob = scope.launch { collectRunStream(selected.baseUrl, agentId, run) }
        return
    }
    scope.launch {
        _uiState.update { it.copy(loading = true, error = null, runStreamNote = null) }
        runCatching {
            feedFromStreamText(api.getRunStreamText(selected.baseUrl, agentId, run.runId))
        }.onSuccess { rows ->
            _uiState.update { it.copy(runFeed = rows, loading = false) }
        }.onFailure { err ->
            _uiState.update { it.copy(loading = false, error = friendlyConnectionError(err)) }
        }
    }
}

/**
 * Web startRunStream parity (app.js:1444-1468): monotonic-seq dedup, immediate reopen
 * on the 30-min stream_timeout, terminal done marks the run finished. A mid-stream
 * drop retries with backoff behind a neutral note — never the Wi-Fi banner.
 */
private suspend fun collectRunStream(baseUrl: String, agentId: String, run: RunDto) {
    var maxSeq = 0
    var backoffMs = 1_000L
    while (currentCoroutineContext().isActive) {
        var terminal: RunStreamEvent.Done? = null
        val attempt = runCatching {
            api.streamRun(baseUrl, agentId, run.runId).collect { event ->
                when (event) {
                    is RunStreamEvent.Line -> if (event.seq > maxSeq) { // drops reconnect replay
                        maxSeq = event.seq
                        backoffMs = 1_000L
                        val rows = RunFeed.classifyLine(event.line)
                        if (rows.isNotEmpty()) {
                            _uiState.update { st ->
                                st.copy(runFeed = (st.runFeed + rows).takeLast(RUN_FEED_CAP), runStreamNote = null)
                            }
                        }
                    }
                    is RunStreamEvent.Done -> {
                        if (event.seq > maxSeq) maxSeq = event.seq
                        terminal = event
                    }
                }
            }
        }
        currentCoroutineContext().ensureActive() // a cancelled collect must not fall into retry
        val done = terminal
        when {
            done != null && done.status == "stream_timeout" -> Unit // server cap: reopen immediately
            done != null -> {
                val status = done.status ?: "exited"
                _uiState.update { st ->
                    st.copy(
                        runFeed = (st.runFeed + RunFeedRow("done", "run-complete", status)).takeLast(RUN_FEED_CAP),
                        selectedRun = st.selectedRun?.takeIf { it.runId == run.runId }?.copy(status = status)
                            ?: st.selectedRun,
                        runStreamNote = null,
                    )
                }
                return
            }
            else -> { // connection dropped (or errored) without a terminal frame
                if (attempt.isFailure) {
                    android.util.Log.w("OrchaApp", "run stream dropped", attempt.exceptionOrNull())
                }
                _uiState.update { it.copy(runStreamNote = "Log stream interrupted — reconnecting…") }
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(15_000L)
            }
        }
    }
}

/** Classify a finished run's buffered SSE text into feed rows (same seq dedup). */
private fun feedFromStreamText(text: String): List<RunFeedRow> {
    val rows = mutableListOf<RunFeedRow>()
    var maxSeq = 0
    text.lineSequence().forEach { raw ->
        when (val event = RunStream.parse(raw)) {
            is RunStreamEvent.Line -> if (event.seq > maxSeq) {
                maxSeq = event.seq
                rows += RunFeed.classifyLine(event.line)
            }
            is RunStreamEvent.Done -> rows += RunFeedRow("done", "run-complete", event.status ?: "ended")
            null -> Unit
        }
    }
    return rows.takeLast(RUN_FEED_CAP)
}

override fun cancelRunStream() {
    runStreamJob?.cancel()
    runStreamJob = null
}

fun openConversation(agentId: String) {
    val agent = _uiState.value.snapshot?.agents?.firstOrNull { it.id == agentId } ?: return
    cancelRunStream()
    cancelReplyWatch()
    _uiState.update {
        it.copy(
            route = AppRoute.Conversation, selectedAgent = agent, conversation = null,
            turns = emptyList(), sendFlow = io.openorcha.mobile.domain.ChatSendFlow(), error = null,
        )
    }
    refreshConversation()
}

override fun refreshConversation() {
    scope.launch { refreshConversationInternal(quiet = false) }
}

/** Chat send-UX: the reply watch's poll — transient errors stay silent (no banner flash)
 *  through the cold-start window a slow first wake can take. */
override suspend fun refreshConversationQuiet(agentId: String) {
    refreshConversationInternal(quiet = true)
}

/**
 * Issue 4 (web conversation.js poll): once mounted, refresh via an after_seq DELTA
 * append instead of re-fetching + replacing the whole transcript. Every successful
 * turns update runs through `sendFlow.observe` (chat send-UX: echo/reply dedupe).
 */
private suspend fun refreshConversationInternal(quiet: Boolean) {
    val selected = _uiState.value.selectedContainer ?: return
    val agent = _uiState.value.selectedAgent ?: return
    val conversation = _uiState.value.conversation
    val lastSeq = _uiState.value.turns.lastOrNull()?.seq ?: 0
    if (conversation != null && lastSeq > 0) {
        runCatching { api.getConversationTurns(selected.baseUrl, conversation.id, afterSeq = lastSeq) }
            .onSuccess { response ->
                if (response.turns.isNotEmpty()) {
                    _uiState.update { st ->
                        val turns = Paging.appendTurns(st.turns, response.turns)
                        st.copy(turns = turns, sendFlow = st.sendFlow.observe(turns, st.selectedContainer?.humanAgentId), error = null)
                    }
                }
            }
            .onFailure { err -> if (!quiet) _uiState.update { it.copy(error = friendlyConnectionError(err)) } }
        return
    }
    // initial mount fetch (web parity: one ?limit=80 load)
    if (!quiet) _uiState.update { it.copy(loading = true, error = null) }
    runCatching { api.getConversation(selected.baseUrl, agent.id) }
        .onSuccess { response ->
            _uiState.update {
                it.copy(
                    conversation = response.conversation, turns = response.turns, loading = false,
                    sendFlow = it.sendFlow.observe(response.turns, it.selectedContainer?.humanAgentId),
                )
            }
        }.onFailure { err ->
            _uiState.update { it.copy(loading = false, error = if (quiet) it.error else friendlyConnectionError(err)) }
        }
}

}
