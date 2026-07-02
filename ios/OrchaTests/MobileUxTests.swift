import Foundation
import Testing
@testable import Orcha

/// Flow-spec pure logic (design package flows 05/07/09/11 + component inventory doc 12).
/// These mappings are BINDING contracts from the design docs — screens render them
/// verbatim. A 1:1 Swift Testing port of the Android `MobileUxSelectorsTest`,
/// `TaskResultShapeTest`, and `ExpiryAndDividerTest`.

// A fixed clock shared by the time-sensitive suites (matches the Android 1_751_400_000_000L ms).
private let fixedNow = Date(timeIntervalSince1970: 1_751_400_000)

@Suite struct MobileUxSelectorsTests {

    // ---------- flow 07 §grouping: the four request groups ----------

    private let h = "human-1"

    private func req(
        id: String,
        status: String = "open",
        requester: String? = "a1",
        target: String? = "human-1",
        expires: String? = nil,
        created: String? = nil
    ) -> RequestDto {
        RequestDto(
            id: id, status: status, payload: "p",
            requesterId: requester, targetId: target,
            createdAt: created, expiresAt: expires
        )
    }

    @Test func requestGroupsFollowTheBindingMatrix() {
        let rows = [
            req(id: "needs-1", status: "open", requester: "a1", target: h),
            req(id: "needs-2", status: "open", requester: "a1", target: nil),      // escalated → human
            req(id: "not-mine", status: "open", requester: "a1", target: "a2"),
            req(id: "waiting-1", status: "open", requester: h, target: "a1"),
            req(id: "waiting-2", status: "accepted", requester: h, target: "a1"),
            req(id: "answered-1", status: "answered", requester: h, target: "a1"),
            req(id: "done-1", status: "closed", requester: h, target: "a1"),
            req(id: "done-2", status: "rejected", requester: "a1", target: h),
            req(id: "done-3", status: "converted_to_task", requester: h, target: "a1"),
            req(id: "done-other", status: "closed", requester: "a1", target: "a2"),  // not involving me
        ]
        let g = MobileUx.requestGroups(rows, humanId: h)
        #expect(g.needsYourAnswer.map(\.id) == ["needs-1", "needs-2"])
        #expect(g.waitingOnOthers.map(\.id) == ["waiting-1", "waiting-2"])
        #expect(g.answeredActOnIt.map(\.id) == ["answered-1"])
        #expect(Set(g.done.map(\.id)) == ["done-1", "done-2", "done-3"])
        // tab badge = needs answer + answered-act-on-it
        #expect(g.badgeCount == 3)
    }

    @Test func needsAnswerOrdersExpiringSoonestFirst() {
        let rows = [
            req(id: "late", expires: "2026-07-01T23:00:00Z", created: "2026-07-01T10:00:00Z"),
            req(id: "soon", expires: "2026-07-01T21:00:00Z", created: "2026-07-01T12:00:00Z"),
            req(id: "none", expires: nil, created: "2026-07-01T09:00:00Z"),
        ]
        let g = MobileUx.requestGroups(rows, humanId: h)
        #expect(g.needsYourAnswer.map(\.id) == ["soon", "late", "none"])
    }

    // ---------- flow 11/05: priority bands (Low/Normal/High ↔ 300/100/20) ----------

    @Test func priorityBandsMatchPortalThresholds() {
        #expect(MobileUx.priorityBand(20) == .high)
        #expect(MobileUx.priorityBand(5) == .high)
        #expect(MobileUx.priorityBand(40) == .elevated)
        #expect(MobileUx.priorityBand(100) == .normal)
        #expect(MobileUx.priorityBand(nil) == .normal)
        #expect(MobileUx.priorityBand(300) == .normal)
        #expect(MobileUx.priorityFor(.high) == 20)
        #expect(MobileUx.priorityFor(.normal) == 100)
        #expect(MobileUx.priorityFor(.low) == 300)
    }

    // ---------- flow 09: agent roster ordering ----------

    @Test func agentOrderPutsWorkingFirstAndTerminatedLast() {
        func agent(_ id: String, _ status: String?) -> AgentDto {
            AgentDto(id: id, alias: id, status: status)
        }
        let sorted = MobileUx.orderAgents([
            agent("idle", "idle"),
            agent("dead", "terminated"),
            agent("working", "working"),
            agent("needs-human", "awaiting_human"),
            agent("blocked", "blocked"),
            agent("waiting", "awaiting_request"),
        ])
        #expect(sorted.map(\.id) == ["working", "needs-human", "blocked", "waiting", "idle", "dead"])
    }

    // ---------- doc 12: binding status display copy ----------

    @Test func statusCopyMatchesComponentInventory() {
        #expect(MobileUx.statusCopy("needs_verification") == "needs verification")
        #expect(MobileUx.statusCopy("converted_to_task") == "became a task")
        #expect(MobileUx.statusCopy("awaiting_request") == "waiting on a request")
        #expect(MobileUx.statusCopy("awaiting_human") == "waiting on you")
        #expect(MobileUx.statusCopy("in_progress") == "in progress")
        #expect(MobileUx.statusCopy("open") == "open")
        #expect(MobileUx.statusCopy("not_ready") == "not ready")
    }

    // ---------- flow 05: "Needs me" chip + status group order ----------

    @Test func needsMeIsVerificationsPlusUndecidedPlans() {
        let tasks = [
            TaskDto(id: "v", title: "v", status: "needs_verification"),
            TaskDto(id: "p", title: "p", status: "in_progress", planMessage: TaskMessageDto(body: "plan")),
            TaskDto(id: "decided", title: "d", status: "in_progress",
                    planMessage: TaskMessageDto(body: "plan"), planDecision: "approve"),
            TaskDto(id: "plain", title: "x", status: "ready"),
        ]
        #expect(Set(MobileUx.needsMe(tasks).map(\.id)) == ["v", "p"])
    }

    @Test func taskGroupOrderFollowsFlow05() {
        let order = [
            "in_progress", "blocked", "needs_verification", "ready",
            "pending", "not_ready", "completed", "cancelled",
        ]
        #expect(order.shuffled().sorted { MobileUx.taskGroupRank($0) < MobileUx.taskGroupRank($1) } == order)
        #expect(MobileUx.taskGroupRank("weird_status") > MobileUx.taskGroupRank("cancelled"))
        // terminal groups collapse by default
        #expect(MobileUx.isTerminalGroup("completed"))
        #expect(MobileUx.isTerminalGroup("cancelled"))
        #expect(!MobileUx.isTerminalGroup("in_progress"))
    }

    // ---------- shared: relative time ("updated 12m ago", heartbeat) ----------

    @Test func relativeAgoRendersCompactUnits() {
        // Android used iso(deltaMs) = now - deltaMs; here we subtract the delta from `fixedNow`.
        func iso(_ deltaSeconds: TimeInterval) -> String {
            ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(-deltaSeconds))
        }
        #expect(MobileUx.agoLabel(iso(20), now: fixedNow) == "just now")
        #expect(MobileUx.agoLabel(iso(5 * 60), now: fixedNow) == "5m ago")
        #expect(MobileUx.agoLabel(iso(2 * 3600), now: fixedNow) == "2h ago")
        #expect(MobileUx.agoLabel(iso(3 * 86400), now: fixedNow) == "3d ago")
        #expect(MobileUx.agoLabel(nil, now: fixedNow) == nil)
        #expect(MobileUx.agoLabel("not-a-date", now: fixedNow) == nil)
    }
}

@Suite struct TaskResultShapeTests {
    private let decoder = JSONDecoder()

    @Test func resultDecodesFromJsonbObjectShape() throws {
        // /done stores tasks.result as JSONB {"result": <text>, "by_agent_id": ...} —
        // the portal had the same bug ([object Object]); the app must unwrap it.
        let json = #"{"id":"t1","title":"x","result":{"result":"Typed errors implemented.","by_agent_id":"a-1"}}"#
        let t = try decoder.decode(TaskDto.self, from: Data(json.utf8))
        #expect(t.result == "Typed errors implemented.")
    }

    @Test func resultDecodesFromPlainStringAndNull() throws {
        let plainJson = #"{"id":"t1","title":"x","result":"legacy plain"}"#
        let s = try decoder.decode(TaskDto.self, from: Data(plainJson.utf8))
        #expect(s.result == "legacy plain")

        let nullJson = #"{"id":"t1","title":"x","result":null}"#
        let n = try decoder.decode(TaskDto.self, from: Data(nullJson.utf8))
        #expect(n.result == nil)
    }
}

@Suite struct PairingPayloadTests {
    // The exact QR shape emitted by GET /api/containers/{cid}/pairing on main.
    private let qr = """
    {"v":1,"kind":"orcha-pair","baseUrl":"http://192.168.1.24:8001",\
    "containerId":"c-1","containerName":"demo","humanAgentId":"h-2",\
    "humanAgentAlias":"Kedar","token":"tok_abc","shortCode":"7Q4F","expiresAt":"2026-07-01T21:40:00Z"}
    """

    @Test func parsesOrchaPairPayload() throws {
        let p = try OrchaServerAddress.parse(qr)
        #expect(p.baseUrl == "http://192.168.1.24:8001")
        #expect(p.containerId == "c-1")
        #expect(p.humanAgentId == "h-2")
        #expect(p.humanAgentAlias == "Kedar")
        #expect(p.token == "tok_abc")
    }

    @Test func plainAddressCarriesNoPairingFields() throws {
        let p = try OrchaServerAddress.parse("192.168.1.24:8001")
        #expect(p.baseUrl == "http://192.168.1.24:8001")
        #expect(p.humanAgentId == nil)
        #expect(p.token == nil)
    }

    @Test func rejectsForeignQrAndLocalhost() {
        #expect(throws: OrchaServerAddress.AddressError.self) {
            _ = try OrchaServerAddress.parse(#"{"kind":"some-other-qr","baseUrl":"x"}"#)
        }
        #expect(throws: OrchaServerAddress.AddressError.self) {
            _ = try OrchaServerAddress.parse("localhost:8001")
        }
    }
}

@Suite struct ExpiryAndDividerTests {

    private func iso(_ deltaSeconds: TimeInterval) -> String {
        // Android used iso(deltaMs) = now + deltaMs; expiry deltas are relative to `fixedNow`.
        ISO8601DateFormatter().string(from: fixedNow.addingTimeInterval(deltaSeconds))
    }

    @Test func expiryChipWarnsUnderTwoHoursAndExpiresPast() {
        // flow 07: warn pill with countdown when expires_at − now < 2h; past → expired + dim
        #expect(MobileUx.expiryChip(nil, now: fixedNow) == nil)
        #expect(MobileUx.expiryChip(iso(3 * 3600), now: fixedNow) == nil)             // 3h out: no chip
        #expect(MobileUx.expiryChip(iso(90 * 60), now: fixedNow) == .warn("expires in 1h 30m"))
        #expect(MobileUx.expiryChip(iso(12 * 60), now: fixedNow) == .warn("expires in 12m"))
        #expect(MobileUx.expiryChip(iso(-60), now: fixedNow) == .expired)
    }

    @Test func dayKeyGroupsTurnsByCalendarDay() {
        // flow 10: day dividers between calendar days (UTC keying is deterministic for tests)
        #expect(MobileUx.dayKey("2026-07-01T21:40:00Z") == "2026-07-01")
        #expect(MobileUx.dayKey("2026-07-02T00:10:00Z") == "2026-07-02")
        #expect(MobileUx.dayKey(nil) == nil)
        #expect(MobileUx.dayLabel("2026-07-01T21:40:00Z") == "Jul 1")
    }
}
