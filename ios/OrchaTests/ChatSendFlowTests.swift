import Foundation
import Testing
@testable import Orcha

/// The conversation composer's send state machine (chat send-UX fix): optimistic
/// pending → sent → cleared-by-echo, tap-to-retry on failure, re-entry guard, and
/// the echo/reply dedupe rules (by content + seq recency — turns carry no client id).

private let human = "human-1"

private func turn(
    seq: Int,
    role: String = "agent",
    author: String? = "agent-1",
    content: String = "hello back",
    createdAt: String? = "2026-07-30T12:00:00Z"
) -> TurnDto {
    TurnDto(id: "t\(seq)", seq: seq, role: role, authorAgentId: author, content: content, runId: nil, createdAt: createdAt)
}

private func mineTurn(seq: Int, content: String) -> TurnDto {
    turn(seq: seq, role: "human", author: human, content: content)
}

@Suite struct ChatSendFlowBeginTests {

    @Test func beginEntersSendingWithPendingBubble() {
        var flow = ChatSendFlow()
        let began = flow.begin(content: "hi", baselineSeq: 4, isFirstTurn: false)
        #expect(began)
        #expect(flow.phase == .sending)
        #expect(flow.isSending)
        #expect(flow.showsPendingBubble)
        #expect(!flow.showsAwaitingReply)
        #expect(flow.content == "hi")
        #expect(flow.baselineSeq == 4)
    }

    @Test func beginRejectsEmptyContent() {
        var flow = ChatSendFlow()
        let began = flow.begin(content: "", baselineSeq: 0, isFirstTurn: true)
        #expect(!began)
        #expect(flow.phase == .idle)
    }

    @Test func beginIsReentryGuardedWhilePostInFlight() {
        var flow = ChatSendFlow()
        let first = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: false)
        // Button mash: a second begin while the POST is in flight must be a no-op.
        let second = flow.begin(content: "hi again", baselineSeq: 0, isFirstTurn: false)
        #expect(first)
        #expect(!second)
        #expect(flow.content == "hi")
    }

    @Test func beginIsBlockedOverAnUnretriedFailure() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: false)
        flow.postFailed("boom")
        // The failed content must be retrieved (tap-to-retry), never silently replaced.
        let began = flow.begin(content: "other", baselineSeq: 0, isFirstTurn: false)
        #expect(!began)
        #expect(flow.failureReason == "boom")
        #expect(flow.content == "hi")
    }

    @Test func beginIsBlockedUntilTheEchoConfirmsThePreviousSend() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 4, isFirstTurn: false)
        flow.postSucceeded()
        #expect(!flow.canBegin)
        flow.observe([mineTurn(seq: 5, content: "hi")], humanId: human)
        // Echo seen → the transcript holds the real turn; a follow-up send may begin.
        #expect(flow.canBegin)
        let followUp = flow.begin(content: "and also", baselineSeq: 5, isFirstTurn: false)
        #expect(followUp)
        #expect(flow.baselineSeq == 5)
    }

    @Test func firstTurnFlagIsCaptured() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: true)
        #expect(flow.isFirstTurn)
    }
}

@Suite struct ChatSendFlowPostOutcomeTests {

    @Test func postSuccessMovesToSentKeepingPendingUntilEcho() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 4, isFirstTurn: false)
        flow.postSucceeded()
        #expect(flow.phase == .sent)
        #expect(!flow.isSending)
        #expect(flow.showsPendingBubble)      // the poll hasn't echoed our turn yet
        #expect(flow.showsAwaitingReply)      // typing indicator up immediately
    }

    @Test func postFailureFlipsToTapToRetryHoldingContent() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 4, isFirstTurn: false)
        flow.postFailed("Could not reach Orcha")
        #expect(flow.isFailed)
        #expect(flow.failureReason == "Could not reach Orcha")
        #expect(flow.showsPendingBubble)      // no silent loss
        #expect(!flow.showsAwaitingReply)
    }

    @Test func takeFailedContentRestoresAndResets() {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: 4, isFirstTurn: false)
        flow.postFailed("boom")
        let restored = flow.takeFailedContent()
        #expect(restored == "hi")
        #expect(flow == ChatSendFlow())       // clean slate — composer restored the text
    }

    @Test func takeFailedContentIsNilOutsideFailure() {
        var flow = ChatSendFlow()
        let fromIdle = flow.takeFailedContent()
        #expect(fromIdle == nil)
        _ = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: false)
        let fromSending = flow.takeFailedContent()
        #expect(fromSending == nil)
    }

    @Test func outcomeEventsOutsideSendingAreNoOps() {
        var flow = ChatSendFlow()
        flow.postSucceeded()
        #expect(flow.phase == .idle)
        flow.postFailed("boom")
        #expect(flow.phase == .idle)
        _ = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: false)
        flow.postFailed("boom")
        flow.postSucceeded()                  // failed → success must not resurrect
        #expect(flow.isFailed)
    }
}

@Suite struct ChatSendFlowEchoDedupeTests {

    private func sentFlow(content: String = "hi", baseline: Int = 4) -> ChatSendFlow {
        var flow = ChatSendFlow()
        _ = flow.begin(content: content, baselineSeq: baseline, isFirstTurn: false)
        flow.postSucceeded()
        return flow
    }

    @Test func echoClearsThePendingBubble() {
        var flow = sentFlow()
        flow.observe([mineTurn(seq: 5, content: "hi")], humanId: human)
        #expect(!flow.showsPendingBubble)     // real turn replaces the optimistic one
        #expect(flow.showsAwaitingReply)      // still waiting on the agent
    }

    @Test func echoMatchesOnTrimmedContent() {
        var flow = sentFlow(content: "hi")
        flow.observe([mineTurn(seq: 5, content: "  hi\n")], humanId: human)
        #expect(!flow.showsPendingBubble)
    }

    @Test func echoIgnoresOlderDuplicateContent() {
        // The dedupe rule that prevents an OLD identical message (seq <= baseline)
        // from being mistaken for this send's echo.
        var flow = sentFlow(content: "hi", baseline: 4)
        flow.observe([mineTurn(seq: 4, content: "hi"), mineTurn(seq: 3, content: "hi")], humanId: human)
        #expect(flow.showsPendingBubble)
    }

    @Test func echoIgnoresDifferentContent() {
        var flow = sentFlow(content: "hi")
        flow.observe([mineTurn(seq: 5, content: "something else")], humanId: human)
        #expect(flow.showsPendingBubble)
    }

    @Test func echoMatchesByAuthorIdEvenWithoutHumanRole() {
        var flow = sentFlow(content: "hi")
        flow.observe([turn(seq: 5, role: "member", author: human, content: "hi")], humanId: human)
        #expect(!flow.showsPendingBubble)
    }
}

@Suite struct ChatSendFlowReplyTests {

    private func sentFlow(baseline: Int = 4) -> ChatSendFlow {
        var flow = ChatSendFlow()
        _ = flow.begin(content: "hi", baselineSeq: baseline, isFirstTurn: false)
        flow.postSucceeded()
        return flow
    }

    @Test func agentReplyResolvesTheWholeSend() {
        var flow = sentFlow()
        flow.observe([mineTurn(seq: 5, content: "hi"), turn(seq: 6)], humanId: human)
        #expect(flow == ChatSendFlow())       // idle: no bubble, no indicator
    }

    @Test func blankAgentReplyStillCountsAsReply() {
        // The session-restart case: an empty turn arrives — the indicator must clear
        // (the transcript renders the no-reply-captured notice instead).
        var flow = sentFlow()
        flow.observe([turn(seq: 6, content: "   ")], humanId: human)
        #expect(!flow.showsAwaitingReply)
        #expect(flow.phase == .idle)
    }

    @Test func systemTurnIsNotAReply() {
        var flow = sentFlow()
        flow.observe([turn(seq: 6, role: "system", author: nil, content: "conversation resumed")], humanId: human)
        #expect(flow.showsAwaitingReply)
    }

    @Test func staleAgentTurnIsNotAReply() {
        var flow = sentFlow(baseline: 4)
        flow.observe([turn(seq: 4)], humanId: human)
        #expect(flow.showsAwaitingReply)
    }

    @Test func ownTurnIsNotAReply() {
        var flow = sentFlow()
        flow.observe([mineTurn(seq: 5, content: "hi")], humanId: human)
        #expect(flow.showsAwaitingReply)
    }

    @Test func overdueSwapsIndicatorForNoteAndStillAcceptsALateReply() {
        var flow = sentFlow()
        flow.replyOverdue()
        #expect(flow.showsOverdueNote)
        #expect(!flow.showsAwaitingReply)
        #expect(flow.canBegin)                // the user may follow up from overdue
        flow.observe([turn(seq: 6)], humanId: human)   // late reply via pull-refresh
        #expect(flow == ChatSendFlow())
    }

    @Test func overdueOnlyFiresFromSent() {
        var flow = ChatSendFlow()
        flow.replyOverdue()
        #expect(flow.phase == .idle)
        _ = flow.begin(content: "hi", baselineSeq: 0, isFirstTurn: false)
        flow.postFailed("boom")
        flow.replyOverdue()
        #expect(flow.isFailed)
    }

    @Test func resetReturnsToCleanSlate() {
        var flow = sentFlow()
        flow.reset()
        #expect(flow == ChatSendFlow())
    }
}

@Suite struct BlankReplyRuleTests {

    @Test(arguments: ["", " ", "\n", "  \n\t "])
    func blankContentIsBlank(_ content: String) {
        #expect(ChatSendFlow.isBlankReply(content))
    }

    @Test func realContentIsNotBlank() {
        #expect(!ChatSendFlow.isBlankReply("done — see the log"))
    }
}


// MARK: - start-conversation decode (PR #223 audit)

/// `POST …/conversations` answers `{conversation, created}` with NO `turns` key; the
/// synthesized decoder threw `keyNotFound`, so the FIRST message to any agent (the
/// only send that starts a conversation) always landed in the failed-send bubble.
@Suite struct StartConversationDecodeTests {
    @Test func postResponseWithoutTurnsDecodes() throws {
        let response = try JSONDecoder().decode(ConversationResponse.self, from: Data("""
        {"conversation": {"id": "c-1", "status": "active"}, "created": true}
        """.utf8))
        #expect(response.conversation?.id == "c-1")
        #expect(response.turns.isEmpty)
    }

    @Test func getResponseWithTurnsStillDecodes() throws {
        let response = try JSONDecoder().decode(ConversationResponse.self, from: Data("""
        {"conversation": {"id": "c-1"}, "turns": [{"id": "t1", "seq": 1, "role": "human", "content": "hi"}]}
        """.utf8))
        #expect(response.turns.map(\.content) == ["hi"])
        let none = try JSONDecoder().decode(ConversationResponse.self,
            from: Data(#"{"conversation": null, "turns": []}"#.utf8))
        #expect(none.conversation == nil && none.turns.isEmpty)
    }
}
