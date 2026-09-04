import Foundation

/// The conversation composer's send lifecycle — a PURE state machine (unit-tested),
/// driven by `AppModel` and rendered by `ConversationScreen`.
///
/// Why it exists (chat send-UX fix): the send POST rides a 10s/20s-timeout session,
/// so a cold first wake can time out client-side while the server still lands the
/// turn. The old path cleared the input immediately and showed nothing in flight,
/// so users resent by hand and got duplicate bubbles. This machine renders the
/// composed message as an optimistic pending bubble the moment the send begins,
/// guards re-entry (no double-send from button mashing), flips to a tap-to-retry
/// state on failure (content preserved — never silently lost), and dedupes the
/// pending bubble against the poll echo by content + seq recency. The POST itself
/// is one-shot: NEVER auto-retried, because a timed-out POST may have landed.
struct ChatSendFlow: Equatable {
    enum Phase: Equatable {
        /// Nothing in flight.
        case idle
        /// The POST is in flight — composer shows a spinner; pending bubble says "sending…".
        case sending
        /// POST accepted. The pending bubble stays until the poll echoes our turn back
        /// (`echoSeen`); the awaiting-reply indicator stays until the agent's turn arrives.
        case sent
        /// POST failed — the pending bubble flips to "tap to retry" holding the content.
        case failed(String)
        /// No reply inside the watch window — a muted "pull to refresh" note replaces
        /// the indicator; a reply observed later (pull-refresh) still clears it.
        case overdue
    }

    private(set) var phase: Phase = .idle
    /// The message being sent (or held for retry after a failure).
    private(set) var content = ""
    /// The newest turn seq held when the send began — echo/reply must be NEWER.
    private(set) var baselineSeq = 0
    /// True when the conversation had no turns at send time — the awaiting-reply copy
    /// says honestly that a cold first wake can take a minute.
    private(set) var isFirstTurn = false
    /// The poll returned our own turn — the pending bubble has "cleared into" it.
    private(set) var echoSeen = false

    // MARK: projections (what the screen renders)

    var isSending: Bool { phase == .sending }

    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    var failureReason: String? {
        if case let .failed(reason) = phase { return reason }
        return nil
    }

    /// The optimistic bubble: while sending, while failed (tap-to-retry), and after a
    /// successful POST until the poll echoes the real turn back (then the real turn
    /// replaces it seamlessly — never both).
    var showsPendingBubble: Bool {
        switch phase {
        case .sending, .failed: true
        case .sent: !echoSeen
        case .idle, .overdue: false
        }
    }

    /// The typing/working indicator row shown between a successful send and the reply.
    var showsAwaitingReply: Bool { phase == .sent }

    var showsOverdueNote: Bool { phase == .overdue }

    /// Re-entry guard: a new send may begin only when nothing is unresolved — never
    /// while a POST is in flight, never over an unretried failure, and not until the
    /// poll has confirmed the previous turn (a moment after each successful POST).
    var canBegin: Bool {
        switch phase {
        case .idle, .overdue: true
        case .sent: echoSeen
        case .sending, .failed: false
        }
    }

    // MARK: events

    /// Begin a send. Returns false (and changes nothing) when re-entry is barred or
    /// the trimmed content is empty — the caller must not POST in that case.
    mutating func begin(content: String, baselineSeq: Int, isFirstTurn: Bool) -> Bool {
        guard canBegin, !content.isEmpty else { return false }
        self.phase = .sending
        self.content = content
        self.baselineSeq = baselineSeq
        self.isFirstTurn = isFirstTurn
        self.echoSeen = false
        return true
    }

    mutating func postSucceeded() {
        guard phase == .sending else { return }
        phase = .sent
    }

    mutating func postFailed(_ reason: String) {
        guard phase == .sending else { return }
        phase = .failed(reason)
    }

    /// Tap-to-retry: hand the failed content back so the composer can restore it,
    /// clearing the failed bubble. Nil unless a failure is actually being held.
    mutating func takeFailedContent() -> String? {
        guard case .failed = phase else { return nil }
        let restored = content
        reset()
        return restored
    }

    /// The bounded reply watch gave up (no reply inside the window).
    mutating func replyOverdue() {
        guard phase == .sent else { return }
        phase = .overdue
    }

    /// Advance against the freshly-polled transcript: our echoed turn clears the
    /// pending bubble; the agent's reply (even a blank one) resolves the whole send.
    mutating func observe(_ turns: [TurnDto], humanId: String?) {
        if phase == .sent, !echoSeen, turns.contains(where: { isEcho($0, humanId: humanId) }) {
            echoSeen = true
        }
        if phase == .sent || phase == .overdue,
           turns.contains(where: { isReply($0, humanId: humanId) }) {
            reset()
        }
    }

    /// Back to a clean slate (agent switch, conversation end, resolved send).
    mutating func reset() {
        self = ChatSendFlow()
    }

    // MARK: rules

    private func isMine(_ turn: TurnDto, humanId: String?) -> Bool {
        turn.role == "human" || (humanId != nil && turn.authorAgentId == humanId)
    }

    /// The poll returning OUR send: a human-authored turn newer than the baseline
    /// whose trimmed content matches (dedupe by content + recency — turns carry no
    /// client-generated id to match on).
    private func isEcho(_ turn: TurnDto, humanId: String?) -> Bool {
        turn.seq > baselineSeq
            && isMine(turn, humanId: humanId)
            && turn.content.trimmingCharacters(in: .whitespacesAndNewlines) == content
    }

    /// The agent's reply: any non-system turn newer than the baseline that is not
    /// ours. Blank content still counts — it renders as the no-reply-captured notice.
    private func isReply(_ turn: TurnDto, humanId: String?) -> Bool {
        turn.seq > baselineSeq
            && turn.role != "system"
            && !isMine(turn, humanId: humanId)
    }

    // MARK: shared rendering rule

    /// An agent turn with no visible content must NEVER render as a blank bubble —
    /// the screen shows the muted "No reply captured" notice instead.
    static func isBlankReply(_ content: String) -> Bool {
        content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
