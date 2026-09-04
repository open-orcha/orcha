package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TurnDto

/**
 * The conversation composer's send lifecycle — a PURE state machine (unit-tested),
 * ported 1:1 from `ios/Orcha/Domain/ChatSendFlow.swift`.
 *
 * Why it exists (chat send-UX fix): the send POST rides a short-timeout HTTP client,
 * so a cold first wake can time out client-side while the server still lands the
 * turn. Clearing the input immediately and showing nothing in flight led to users
 * resending by hand and getting duplicate bubbles. This machine renders the composed
 * message as an optimistic pending bubble the moment the send begins, guards
 * re-entry (no double-send from button mashing), flips to a tap-to-retry state on
 * failure (content preserved — never silently lost), and dedupes the pending bubble
 * against the poll echo by content + seq recency. The POST itself is one-shot: NEVER
 * auto-retried, because a timed-out POST may have landed.
 */
data class ChatSendFlow(
    val phase: Phase = Phase.Idle,
    /** The message being sent (or held for retry after a failure). */
    val content: String = "",
    /** The newest turn seq held when the send began — echo/reply must be NEWER. */
    val baselineSeq: Int = 0,
    /** True when the conversation had no turns at send time — the awaiting-reply copy
     *  says honestly that a cold first wake can take a minute. */
    val isFirstTurn: Boolean = false,
    /** The poll returned our own turn — the pending bubble has "cleared into" it. */
    val echoSeen: Boolean = false,
) {
    sealed class Phase {
        /** Nothing in flight. */
        object Idle : Phase()

        /** The POST is in flight — composer shows a spinner; pending bubble says "sending…". */
        object Sending : Phase()

        /** POST accepted. The pending bubble stays until the poll echoes our turn back
         *  (`echoSeen`); the awaiting-reply indicator stays until the agent's turn arrives. */
        object Sent : Phase()

        /** POST failed — the pending bubble flips to "tap to retry" holding the content. */
        data class Failed(val reason: String) : Phase()

        /** No reply inside the watch window — a muted "pull to refresh" note replaces
         *  the indicator; a reply observed later (pull-refresh) still clears it. */
        object Overdue : Phase()
    }

    // ---------- projections (what the screen renders) ----------

    val isSending: Boolean get() = phase is Phase.Sending

    val isFailed: Boolean get() = phase is Phase.Failed

    val failureReason: String? get() = (phase as? Phase.Failed)?.reason

    /**
     * The optimistic bubble: while sending, while failed (tap-to-retry), and after a
     * successful POST until the poll echoes the real turn back (then the real turn
     * replaces it seamlessly — never both).
     */
    val showsPendingBubble: Boolean
        get() = when (phase) {
            is Phase.Sending, is Phase.Failed -> true
            is Phase.Sent -> !echoSeen
            is Phase.Idle, is Phase.Overdue -> false
        }

    /** The typing/working indicator row shown between a successful send and the reply. */
    val showsAwaitingReply: Boolean get() = phase is Phase.Sent

    val showsOverdueNote: Boolean get() = phase is Phase.Overdue

    /**
     * Re-entry guard: a new send may begin only when nothing is unresolved — never
     * while a POST is in flight, never over an unretried failure, and not until the
     * poll has confirmed the previous turn (a moment after each successful POST).
     */
    val canBegin: Boolean
        get() = when (phase) {
            is Phase.Idle, is Phase.Overdue -> true
            is Phase.Sent -> echoSeen
            is Phase.Sending, is Phase.Failed -> false
        }

    // ---------- events ----------

    /**
     * Begin a send. Returns `this` unchanged (with `began = false`) when re-entry is
     * barred or the trimmed content is empty — the caller must not POST in that case.
     */
    fun begin(content: String, baselineSeq: Int, isFirstTurn: Boolean): BeginResult {
        if (!canBegin || content.isEmpty()) return BeginResult(this, began = false)
        val next = ChatSendFlow(
            phase = Phase.Sending,
            content = content,
            baselineSeq = baselineSeq,
            isFirstTurn = isFirstTurn,
            echoSeen = false,
        )
        return BeginResult(next, began = true)
    }

    data class BeginResult(val flow: ChatSendFlow, val began: Boolean)

    fun postSucceeded(): ChatSendFlow {
        if (phase !is Phase.Sending) return this
        return copy(phase = Phase.Sent)
    }

    fun postFailed(reason: String): ChatSendFlow {
        if (phase !is Phase.Sending) return this
        return copy(phase = Phase.Failed(reason))
    }

    /**
     * Tap-to-retry: hand the failed content back so the composer can restore it,
     * clearing the failed bubble. Second value is null unless a failure is actually
     * being held.
     */
    fun takeFailedContent(): TakeFailedResult {
        val failed = phase as? Phase.Failed ?: return TakeFailedResult(this, null)
        return TakeFailedResult(ChatSendFlow(), content)
    }

    data class TakeFailedResult(val flow: ChatSendFlow, val content: String?)

    /** The bounded reply watch gave up (no reply inside the window). */
    fun replyOverdue(): ChatSendFlow {
        if (phase !is Phase.Sent) return this
        return copy(phase = Phase.Overdue)
    }

    /**
     * Advance against the freshly-polled transcript: our echoed turn clears the
     * pending bubble; the agent's reply (even a blank one) resolves the whole send.
     */
    fun observe(turns: List<TurnDto>, humanId: String?): ChatSendFlow {
        var next = this
        if (next.phase is Phase.Sent && !next.echoSeen && turns.any { isEcho(it, humanId) }) {
            next = next.copy(echoSeen = true)
        }
        if ((next.phase is Phase.Sent || next.phase is Phase.Overdue) && turns.any { isReply(it, humanId) }) {
            next = ChatSendFlow()
        }
        return next
    }

    /** Back to a clean slate (agent switch, conversation end, resolved send). */
    fun reset(): ChatSendFlow = ChatSendFlow()

    // ---------- rules ----------

    private fun isMine(turn: TurnDto, humanId: String?): Boolean =
        turn.role == "human" || (humanId != null && turn.authorAgentId == humanId)

    /**
     * The poll returning OUR send: a human-authored turn newer than the baseline
     * whose trimmed content matches (dedupe by content + recency — turns carry no
     * client-generated id to match on).
     */
    private fun isEcho(turn: TurnDto, humanId: String?): Boolean =
        turn.seq > baselineSeq && isMine(turn, humanId) && turn.content.trim() == content

    /**
     * The agent's reply: any non-system turn newer than the baseline that is not
     * ours. Blank content still counts — it renders as the no-reply-captured notice.
     */
    private fun isReply(turn: TurnDto, humanId: String?): Boolean =
        turn.seq > baselineSeq && turn.role != "system" && !isMine(turn, humanId)

    companion object {
        /**
         * An agent turn with no visible content must NEVER render as a blank bubble —
         * the screen shows the muted "No reply captured" notice instead.
         */
        fun isBlankReply(content: String): Boolean = content.trim().isEmpty()
    }
}
