package io.openorcha.mobile.domain

import io.openorcha.mobile.data.TurnDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The conversation composer's send state machine (chat send-UX fix): optimistic
 * pending -> sent -> cleared-by-echo, tap-to-retry on failure, re-entry guard, and
 * the echo/reply dedupe rules (by content + seq recency — turns carry no client id).
 * Ports `ios/OrchaTests/ChatSendFlowTests.swift` 1:1.
 */
class ChatSendFlowTest {

    private val human = "human-1"

    private fun turn(
        seq: Int,
        role: String = "agent",
        author: String? = "agent-1",
        content: String = "hello back",
        createdAt: String? = "2026-07-30T12:00:00Z",
    ) = TurnDto(id = "t$seq", seq = seq, role = role, authorAgentId = author, content = content, runId = null, createdAt = createdAt)

    private fun mineTurn(seq: Int, content: String) = turn(seq = seq, role = "human", author = human, content = content)

    private fun sentFlow(content: String = "hi", baseline: Int = 4): ChatSendFlow {
        val (flow, _) = ChatSendFlow().begin(content = content, baselineSeq = baseline, isFirstTurn = false)
        return flow.postSucceeded()
    }

    // ---------- begin ----------

    @Test
    fun beginEntersSendingWithPendingBubble() {
        val (flow, began) = ChatSendFlow().begin(content = "hi", baselineSeq = 4, isFirstTurn = false)
        assertTrue(began)
        assertTrue(flow.phase is ChatSendFlow.Phase.Sending)
        assertTrue(flow.isSending)
        assertTrue(flow.showsPendingBubble)
        assertFalse(flow.showsAwaitingReply)
        assertEquals("hi", flow.content)
        assertEquals(4, flow.baselineSeq)
    }

    @Test
    fun beginRejectsEmptyContent() {
        val (flow, began) = ChatSendFlow().begin(content = "", baselineSeq = 0, isFirstTurn = true)
        assertFalse(began)
        assertTrue(flow.phase is ChatSendFlow.Phase.Idle)
    }

    @Test
    fun beginIsReentryGuardedWhilePostInFlight() {
        val (afterFirst, first) = ChatSendFlow().begin(content = "hi", baselineSeq = 0, isFirstTurn = false)
        // Button mash: a second begin while the POST is in flight must be a no-op.
        val (afterSecond, second) = afterFirst.begin(content = "hi again", baselineSeq = 0, isFirstTurn = false)
        assertTrue(first)
        assertFalse(second)
        assertEquals("hi", afterSecond.content)
    }

    @Test
    fun beginIsBlockedOverAnUnretriedFailure() {
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 0, isFirstTurn = false)
        val failed = sending.postFailed("boom")
        // The failed content must be retrieved (tap-to-retry), never silently replaced.
        val (afterAttempt, began) = failed.begin(content = "other", baselineSeq = 0, isFirstTurn = false)
        assertFalse(began)
        assertEquals("boom", afterAttempt.failureReason)
        assertEquals("hi", afterAttempt.content)
    }

    @Test
    fun beginIsBlockedUntilTheEchoConfirmsThePreviousSend() {
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 4, isFirstTurn = false)
        val sent = sending.postSucceeded()
        assertFalse(sent.canBegin)
        val observed = sent.observe(listOf(mineTurn(seq = 5, content = "hi")), humanId = human)
        // Echo seen -> the transcript holds the real turn; a follow-up send may begin.
        assertTrue(observed.canBegin)
        val (afterFollowUp, followUp) = observed.begin(content = "and also", baselineSeq = 5, isFirstTurn = false)
        assertTrue(followUp)
        assertEquals(5, afterFollowUp.baselineSeq)
    }

    @Test
    fun firstTurnFlagIsCaptured() {
        val (flow, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 0, isFirstTurn = true)
        assertTrue(flow.isFirstTurn)
    }

    // ---------- post outcome ----------

    @Test
    fun postSuccessMovesToSentKeepingPendingUntilEcho() {
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 4, isFirstTurn = false)
        val sent = sending.postSucceeded()
        assertTrue(sent.phase is ChatSendFlow.Phase.Sent)
        assertFalse(sent.isSending)
        assertTrue(sent.showsPendingBubble) // the poll hasn't echoed our turn yet
        assertTrue(sent.showsAwaitingReply) // typing indicator up immediately
    }

    @Test
    fun postFailureFlipsToTapToRetryHoldingContent() {
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 4, isFirstTurn = false)
        val failed = sending.postFailed("Could not reach Orcha")
        assertTrue(failed.isFailed)
        assertEquals("Could not reach Orcha", failed.failureReason)
        assertTrue(failed.showsPendingBubble) // no silent loss
        assertFalse(failed.showsAwaitingReply)
    }

    @Test
    fun takeFailedContentRestoresAndResets() {
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 4, isFirstTurn = false)
        val failed = sending.postFailed("boom")
        val (flow, restored) = failed.takeFailedContent()
        assertEquals("hi", restored)
        assertEquals(ChatSendFlow(), flow) // clean slate — composer restored the text
    }

    @Test
    fun takeFailedContentIsNilOutsideFailure() {
        val (idleFlow, fromIdle) = ChatSendFlow().takeFailedContent()
        assertNull(fromIdle)
        val (sending, _) = idleFlow.begin(content = "hi", baselineSeq = 0, isFirstTurn = false)
        val (_, fromSending) = sending.takeFailedContent()
        assertNull(fromSending)
    }

    @Test
    fun outcomeEventsOutsideSendingAreNoOps() {
        val afterSucceed = ChatSendFlow().postSucceeded()
        assertTrue(afterSucceed.phase is ChatSendFlow.Phase.Idle)
        val afterFail = ChatSendFlow().postFailed("boom")
        assertTrue(afterFail.phase is ChatSendFlow.Phase.Idle)
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 0, isFirstTurn = false)
        val failed = sending.postFailed("boom")
        val stillFailed = failed.postSucceeded() // failed -> success must not resurrect
        assertTrue(stillFailed.isFailed)
    }

    // ---------- echo dedupe ----------

    @Test
    fun echoClearsThePendingBubble() {
        val observed = sentFlow().observe(listOf(mineTurn(seq = 5, content = "hi")), humanId = human)
        assertFalse(observed.showsPendingBubble) // real turn replaces the optimistic one
        assertTrue(observed.showsAwaitingReply)  // still waiting on the agent
    }

    @Test
    fun echoMatchesOnTrimmedContent() {
        val observed = sentFlow(content = "hi").observe(listOf(mineTurn(seq = 5, content = "  hi\n")), humanId = human)
        assertFalse(observed.showsPendingBubble)
    }

    @Test
    fun echoIgnoresOlderDuplicateContent() {
        // The dedupe rule that prevents an OLD identical message (seq <= baseline)
        // from being mistaken for this send's echo.
        val observed = sentFlow(content = "hi", baseline = 4)
            .observe(listOf(mineTurn(seq = 4, content = "hi"), mineTurn(seq = 3, content = "hi")), humanId = human)
        assertTrue(observed.showsPendingBubble)
    }

    @Test
    fun echoIgnoresDifferentContent() {
        val observed = sentFlow(content = "hi").observe(listOf(mineTurn(seq = 5, content = "something else")), humanId = human)
        assertTrue(observed.showsPendingBubble)
    }

    @Test
    fun echoMatchesByAuthorIdEvenWithoutHumanRole() {
        val observed = sentFlow(content = "hi")
            .observe(listOf(turn(seq = 5, role = "member", author = human, content = "hi")), humanId = human)
        assertFalse(observed.showsPendingBubble)
    }

    // ---------- reply ----------

    @Test
    fun agentReplyResolvesTheWholeSend() {
        val observed = sentFlow().observe(listOf(mineTurn(seq = 5, content = "hi"), turn(seq = 6)), humanId = human)
        assertEquals(ChatSendFlow(), observed) // idle: no bubble, no indicator
    }

    @Test
    fun blankAgentReplyStillCountsAsReply() {
        // The session-restart case: an empty turn arrives — the indicator must clear
        // (the transcript renders the no-reply-captured notice instead).
        val observed = sentFlow().observe(listOf(turn(seq = 6, content = "   ")), humanId = human)
        assertFalse(observed.showsAwaitingReply)
        assertTrue(observed.phase is ChatSendFlow.Phase.Idle)
    }

    @Test
    fun systemTurnIsNotAReply() {
        val observed = sentFlow().observe(listOf(turn(seq = 6, role = "system", author = null, content = "conversation resumed")), humanId = human)
        assertTrue(observed.showsAwaitingReply)
    }

    @Test
    fun staleAgentTurnIsNotAReply() {
        val observed = sentFlow(baseline = 4).observe(listOf(turn(seq = 4)), humanId = human)
        assertTrue(observed.showsAwaitingReply)
    }

    @Test
    fun ownTurnIsNotAReply() {
        val observed = sentFlow().observe(listOf(mineTurn(seq = 5, content = "hi")), humanId = human)
        assertTrue(observed.showsAwaitingReply)
    }

    @Test
    fun overdueSwapsIndicatorForNoteAndStillAcceptsALateReply() {
        val overdue = sentFlow().replyOverdue()
        assertTrue(overdue.showsOverdueNote)
        assertFalse(overdue.showsAwaitingReply)
        assertTrue(overdue.canBegin) // the user may follow up from overdue
        val observed = overdue.observe(listOf(turn(seq = 6)), humanId = human) // late reply via pull-refresh
        assertEquals(ChatSendFlow(), observed)
    }

    @Test
    fun overdueOnlyFiresFromSent() {
        val idleOverdue = ChatSendFlow().replyOverdue()
        assertTrue(idleOverdue.phase is ChatSendFlow.Phase.Idle)
        val (sending, _) = ChatSendFlow().begin(content = "hi", baselineSeq = 0, isFirstTurn = false)
        val failed = sending.postFailed("boom").replyOverdue()
        assertTrue(failed.isFailed)
    }

    @Test
    fun resetReturnsToCleanSlate() {
        assertEquals(ChatSendFlow(), sentFlow().reset())
    }

    // ---------- blank reply rule ----------

    @Test
    fun blankContentIsBlank() {
        for (content in listOf("", " ", "\n", "  \n\t ")) {
            assertTrue(ChatSendFlow.isBlankReply(content), "expected blank for [$content]")
        }
    }

    @Test
    fun realContentIsNotBlank() {
        assertFalse(ChatSendFlow.isBlankReply("done — see the log"))
    }
}
