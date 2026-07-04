import Foundation
import Testing
@testable import Orcha

/// Pure-logic tests for the four-fixes work (task 3fbd363b, GH #30 iOS):
/// Issue 1 — request alias resolution + web-parity chip filter + status-bucket sort + glyphs,
/// Issue 3 — SSE run-log frame parsing, Issue 4 — keyset prepend + `after_seq` append reducers.
/// All mappings are web-portal parity contracts (see docs/plans/ios-four-fixes-plan.md).

@Suite struct RequestLensAndSortTests {

    private func agent(_ id: String, kind: String = "ai") -> AgentDto {
        AgentDto(id: id, alias: id.uppercased(), kind: kind)
    }
    private let roster = [
        AgentDto(id: "a1", alias: "Ada", kind: "ai"),
        AgentDto(id: "a2", alias: "Bob", kind: "ai"),
        AgentDto(id: "h1", alias: "Kedar", kind: "human"),
    ]

    private func req(
        _ id: String, type: String = "info", status: String = "open",
        priority: Int? = nil, requester: String? = "a1", target: String? = "a2",
        created: String? = nil
    ) -> RequestDto {
        RequestDto(id: id, type: type, status: status, priority: priority,
                   requesterId: requester, targetId: target, createdAt: created)
    }

    // ---------- Issue 1: alias resolution (no more "?" avatars) ----------

    @Test func aliasForResolvesFromRosterAndNilStaysNil() {
        #expect(MobileUx.aliasFor("a1", in: roster) == "Ada")
        #expect(MobileUx.aliasFor("h1", in: roster) == "Kedar")
        #expect(MobileUx.aliasFor("ghost", in: roster) == nil)   // not in roster
        #expect(MobileUx.aliasFor(nil, in: roster) == nil)
    }

    // ---------- Issue 1: isToHuman (web app.js:247-256) ----------

    @Test func isToHumanMatchesWebSemantics() {
        // no explicit target → routed to the human
        #expect(MobileUx.isToHuman(req("r", target: nil), agents: roster))
        // target resolves to a human agent
        #expect(MobileUx.isToHuman(req("r", target: "h1"), agents: roster))
        // target resolves to an AI agent → not to human
        #expect(!MobileUx.isToHuman(req("r", target: "a2"), agents: roster))
        // target id absent from roster → not to human (web returns false)
        #expect(!MobileUx.isToHuman(req("r", target: "ghost"), agents: roster))
    }

    // ---------- Issue 1: chip filters over the full snapshot ----------

    @Test func chipFiltersMatchWebMatches() {
        let rows = [
            req("open-ai", status: "open", target: "a2"),
            req("open-human", status: "open", target: "h1"),
            req("answered", status: "answered", target: "a2"),
            req("closed", status: "closed", target: "a2"),
            req("task", type: "task", status: "open", target: "a2"),
        ]
        func ids(_ lens: MobileUx.RequestLens) -> Set<String> {
            Set(MobileUx.filterRequests(rows, lens: lens, agents: roster).map(\.id))
        }
        #expect(ids(.all) == ["open-ai", "open-human", "answered", "closed", "task"])
        #expect(ids(.yours) == ["open-ai", "open-human", "answered", "closed", "task"])  // grouped view handles "yours"
        #expect(ids(.open) == ["open-ai", "open-human", "task"])       // status == open (task is open too)
        #expect(ids(.answered) == ["answered"])
        #expect(ids(.escalated) == ["open-human"])                    // isToHuman, no status filter
        #expect(ids(.task) == ["task"])
    }

    @Test func escalatedChipHasNoStatusFilter() {
        // an ANSWERED request to the human still matches the Escalations chip (web parity)
        let rows = [req("done-to-human", status: "answered", target: "h1")]
        #expect(MobileUx.filterRequests(rows, lens: .escalated, agents: roster).map(\.id) == ["done-to-human"])
    }

    // ---------- Issue 1: sort — status bucket is the outer key ----------

    private func iso(_ s: String) -> String { s }  // already ISO strings in these fixtures

    @Test func sortKeepsStatusBucketOuterThenTimeDesc() {
        let rows = [
            req("rest",     status: "closed",   created: "2026-07-02T10:00:00Z"),
            req("open-old",  status: "open",     created: "2026-07-01T10:00:00Z"),
            req("answered", status: "answered", created: "2026-07-02T09:00:00Z"),
            req("open-new",  status: "open",     created: "2026-07-02T12:00:00Z"),
        ]
        // default: time desc → within the open bucket newest first, buckets open→answered→rest
        let sorted = MobileUx.sortRequests(rows, key: .time, ascending: false)
        #expect(sorted.map(\.id) == ["open-new", "open-old", "answered", "rest"])
    }

    @Test func timeAscendingFlipsWithinBucketsOnly() {
        let rows = [
            req("open-old", status: "open", created: "2026-07-01T10:00:00Z"),
            req("open-new", status: "open", created: "2026-07-02T12:00:00Z"),
            req("answered", status: "answered", created: "2026-07-02T09:00:00Z"),
        ]
        let sorted = MobileUx.sortRequests(rows, key: .time, ascending: true)
        #expect(sorted.map(\.id) == ["open-old", "open-new", "answered"])  // buckets intact, time asc inside
    }

    @Test func priorityAscendingPutsHigherPriorityFirst() {
        // priority ascending = higher priority (lower number) first, within the bucket (web)
        let rows = [
            req("low",  status: "open", priority: 300, created: "2026-07-02T12:00:00Z"),
            req("high", status: "open", priority: 20,  created: "2026-07-01T10:00:00Z"),
            req("norm", status: "open", priority: 100, created: "2026-07-02T11:00:00Z"),
        ]
        let sorted = MobileUx.sortRequests(rows, key: .priority, ascending: true)
        #expect(sorted.map(\.id) == ["high", "norm", "low"])
    }

    // ---------- Issue 1: status glyphs (mobile adaptation of the web text pill) ----------

    @Test func statusGlyphsMapPerState() {
        #expect(MobileUx.requestStatusGlyph("open", escalated: true) == "xmark.octagon.fill")
        #expect(MobileUx.requestStatusGlyph("open", escalated: false) == "exclamationmark.triangle.fill")
        #expect(MobileUx.requestStatusGlyph("accepted", escalated: false) == "play.fill")
        #expect(MobileUx.requestStatusGlyph("answered", escalated: false) == "checkmark.circle.fill")
        #expect(MobileUx.requestStatusGlyph("rejected", escalated: false) == "xmark.circle.fill")
        #expect(MobileUx.requestStatusGlyph("converted_to_task", escalated: false) == "arrow.right.circle.fill")
        #expect(MobileUx.requestStatusGlyph("closed", escalated: false) == "circle.fill")
    }
}

@Suite struct RunLogSseParseTests {

    @Test func parsesProgressLineFrame() {
        guard case let .line(seq, text)? = OrchaApiClient.parseSseEvent(#"data: {"seq": 7, "line": "hello world"}"#) else {
            Issue.record("expected a .line event"); return
        }
        #expect(seq == 7)
        #expect(text == "hello world")
    }

    @Test func parsesTerminalDoneFrame() {
        guard case let .done(seq, status)? = OrchaApiClient.parseSseEvent(#"data: {"seq": 42, "done": true, "status": "finished"}"#) else {
            Issue.record("expected a .done event"); return
        }
        #expect(seq == 42)
        #expect(status == "finished")
    }

    @Test func classifiesStreamTimeoutDone() {
        guard case let .done(_, status)? = OrchaApiClient.parseSseEvent(#"data: {"seq": 99, "done": true, "status": "stream_timeout"}"#) else {
            Issue.record("expected a .done event"); return
        }
        #expect(status == "stream_timeout")
    }

    @Test func skipsHeartbeatCommentBlankAndNonData() {
        #expect(OrchaApiClient.parseSseEvent(":") == nil)               // heartbeat comment
        #expect(OrchaApiClient.parseSseEvent(": keep-alive") == nil)
        #expect(OrchaApiClient.parseSseEvent("") == nil)               // blank
        #expect(OrchaApiClient.parseSseEvent("event: message") == nil) // non-data field
        #expect(OrchaApiClient.parseSseEvent("data: not-json") == nil) // malformed payload
    }
}

@Suite struct PagingReducerTests {

    private func msg(_ id: String, _ body: String = "b") -> TaskMessageDto {
        TaskMessageDto(body: body, messageId: id)
    }
    private func turn(_ seq: Int) -> TurnDto {
        TurnDto(id: "t\(seq)", seq: seq, content: "c\(seq)")
    }

    // ---------- Issue 4: keyset "Load earlier" prepend, dedup at the seam ----------

    @Test func prependPutsOlderPageOnTopWithoutSeamDuplicates() {
        let existing = [msg("m3"), msg("m4"), msg("m5")]
        let older = [msg("m1"), msg("m2"), msg("m3")]   // m3 overlaps the seam
        let merged = MobileUx.prependMessages(older, before: existing)
        #expect(merged.compactMap(\.messageId) == ["m1", "m2", "m3", "m4", "m5"])
    }

    @Test func prependKeepsRowsWithNoIdRatherThanDropThem() {
        let existing = [msg("m2")]
        let older = [TaskMessageDto(body: "no-id"), msg("m1")]
        let merged = MobileUx.prependMessages(older, before: existing)
        #expect(merged.count == 3)                       // the id-less row is preserved
        #expect(merged.last?.messageId == "m2")
    }

    // ---------- Issue 4: conversation after_seq delta append, dedup by seq ----------

    @Test func appendTurnsDropsSeqsAlreadyHeld() {
        let existing = [turn(1), turn(2), turn(3)]
        let delta = [turn(3), turn(4), turn(5)]          // seq 3 overlaps
        let merged = MobileUx.appendTurns(existing, delta: delta)
        #expect(merged.map(\.seq) == [1, 2, 3, 4, 5])
    }

    @Test func appendTurnsOnEmptyDeltaIsIdentity() {
        let existing = [turn(1), turn(2)]
        #expect(MobileUx.appendTurns(existing, delta: []).map(\.seq) == [1, 2])
    }
}
