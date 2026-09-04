package io.openorcha.mobile.ui

import io.openorcha.mobile.domain.ChatSendFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource

/**
 * Chat send-UX (iOS `AppModel.sendTurn`/`startReplyWatch` parity): drives the pure
 * `ChatSendFlow` state machine for the agent-conversation composer. Optimistic
 * one-shot send — `sendFlow.begin` guards re-entry (button mashing) and renders the
 * pending bubble immediately; success hands off to the bounded reply watch; failure
 * keeps the content in the tap-to-retry bubble. The POST is NEVER auto-retried — a
 * timed-out POST may still land server-side, and a blind resend is exactly the
 * duplicate-turn bug this flow exists to prevent.
 */
internal interface ChatSendActions : OrchaViewModelAccess {

fun sendConversationTurn(content: String) {
    val selected = _uiState.value.selectedContainer ?: return
    val actor = selected.humanAgentId ?: run {
        _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
        return
    }
    val agent = _uiState.value.selectedAgent ?: return
    val trimmed = content.trim()
    val turns = _uiState.value.turns
    val (begun, began) = _uiState.value.sendFlow.begin(
        content = trimmed,
        baselineSeq = turns.maxOfOrNull { it.seq } ?: 0,
        isFirstTurn = turns.isEmpty(),
    )
    if (!began) return
    _uiState.update { it.copy(sendFlow = begun, error = null) }
    scope.launch {
        runCatching {
            val conversation = _uiState.value.conversation
                ?: api.startConversation(selected.baseUrl, agent.id, actor).conversation
            val conversationId = conversation?.id ?: error("Conversation did not start")
            if (_uiState.value.conversation == null) {
                _uiState.update { it.copy(conversation = conversation) }
            }
            api.sendConversationTurn(selected.baseUrl, conversationId, actor, trimmed)
        }.onSuccess {
            _uiState.update { it.copy(sendFlow = it.sendFlow.postSucceeded()) }
            startReplyWatch(agent.id)
        }.onFailure { err ->
            _uiState.update { it.copy(sendFlow = it.sendFlow.postFailed(friendlyConnectionError(err))) }
        }
    }
}

/** Tap-to-retry: pull the failed send's text back for the composer (clears the bubble). */
fun takeFailedSendContent(): String? {
    val (flow, content) = _uiState.value.sendFlow.takeFailedContent()
    if (content != null) _uiState.update { it.copy(sendFlow = flow) }
    return content
}

/**
 * The bounded post-send poll awaiting the echo + the reply (iOS `startReplyWatch`):
 * there is no conversation SSE yet, and the 30s snapshot poll never touches `turns`.
 * Bounded: 2.5s cadence for 3 minutes (a cold first wake can take a minute+), then the
 * flow flips to the overdue note. Survives a navigation away (owns no view state); a
 * fresh send replaces it.
 */
private fun startReplyWatch(agentId: String) {
    replyWatchJob?.cancel()
    replyWatchJob = scope.launch {
        val start = TimeSource.Monotonic.markNow()
        while (true) {
            refreshConversationQuiet(agentId)
            if (!_uiState.value.sendFlow.showsAwaitingReply) return@launch  // resolved or superseded
            if (start.elapsedNow() > 180.seconds) {
                _uiState.update { it.copy(sendFlow = it.sendFlow.replyOverdue()) }
                return@launch
            }
            delay(2_500.milliseconds)
        }
    }
}

override fun cancelReplyWatch() {
    replyWatchJob?.cancel()
    replyWatchJob = null
}

}
