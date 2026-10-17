import Foundation
import Testing
@testable import Orcha

/// Agent slice: budgets, reporting lines, live changes, config history — decoding of the
/// real server payloads plus the pure copy/logic ported from the web models.
struct AgentSliceTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: budgets

    @Test func decodesAgentBudgetWithNoLimit() throws {
        // Captured from a live stack (GET /api/agents/{aid}/budget).
        let b = try decode(AgentBudgetDto.self, """
        {"period":"2026-10","starts_at":"2026-10-01T00:00:00+00:00","resets_at":"2026-11-01T00:00:00+00:00",
         "limits":{"usd":null,"tokens":null},
         "usage":{"spend_usd":0.0,"metered_runs":0,"unmetered_runs":0,"unmetered_tokens":0,"tokens":0,"cache_tokens":0,"runs":0,"in_flight_runs":0},
         "state":"none","usd_ratio":null,"token_ratio":null,"limits_reached":[],"paused":false,
         "override":{"active":false,"granted_by":null,"granted_at":null,"note":null},
         "updated_at":null,"agent_id":"a1","alias":"atlas","blocked_by":null,"reason":null,"project":{}}
        """)
        #expect(b.agentId == "a1")
        #expect(b.hasLimit == false)
        #expect(b.paused == false)
        #expect(AgentBudgetUx.healthLabel(b) == nil)
        #expect(AgentBudgetUx.rosterLine(b) == nil)
    }

    @Test func decodesPausedBudgetAndContainerList() throws {
        let list = try decode(ContainerBudgetsDto.self, """
        {"period":"2026-10","agents":[{"agent_id":"a1","alias":"atlas","limits":{"usd":50,"tokens":null},
          "usage":{"spend_usd":51.2,"metered_runs":4,"unmetered_runs":0,"tokens":120000,"runs":4,"in_flight_runs":1},
          "state":"exceeded","usd_ratio":1.024,"token_ratio":null,"paused":true,
          "override":{"active":false},"blocked_by":"agent","reason":"$51.20 of $50.00 — paused for new runs"}]}
        """)
        let b = try #require(list.agents.first)
        #expect(b.paused)
        #expect(b.blockedBy == "agent")
        #expect(b.limits.usd == 50)
        #expect(b.usage.inFlightRuns == 1)
        #expect(AgentBudgetUx.healthLabel(b) == "Paused")
        #expect(AgentBudgetUx.rosterLine(b) == "$51.20 of $50.00")
        #expect(AgentBudgetUx.tone(AgentBudgetUx.worstRatio(b)) == .over)
    }

    @Test func unmeteredSpendIsNeverZeroDollars() throws {
        let b = try decode(AgentBudgetDto.self, """
        {"limits":{"usd":20,"tokens":1000000},"usage":{"spend_usd":0,"metered_runs":0,"unmetered_runs":3,"unmetered_tokens":4000,"tokens":4000,"runs":3},
         "state":"ok","usd_ratio":0,"token_ratio":0.004,"paused":false,"override":{"active":false}}
        """)
        #expect(b.spendUnknown)
        // The roster falls back to the token cap rather than claiming "$0.00".
        #expect(AgentBudgetUx.rosterLine(b) == "4k of 1M tokens")
    }

    @Test func budgetFormattingMatchesWeb() {
        #expect(AgentBudgetUx.usd(1234.5) == "$1,234.50")
        #expect(AgentBudgetUx.tokens(812) == "812")
        #expect(AgentBudgetUx.tokens(1500) == "1.5k")
        #expect(AgentBudgetUx.tokens(45_000) == "45k")
        #expect(AgentBudgetUx.tokens(1_000_000) == "1M")
        #expect(AgentBudgetUx.tokens(12_400_000) == "12M")
        #expect(AgentBudgetUx.percent(0.823) == "82%")
        #expect(AgentBudgetUx.percent(999) == ">999%")
        #expect(AgentBudgetUx.percent(nil) == "")
        #expect(AgentBudgetUx.fill(1.7) == 1)
        #expect(AgentBudgetUx.tone(0.85) == .warn)
        #expect(AgentBudgetUx.tone(0.2) == .ok)
        #expect(AgentBudgetUx.period("2026-10") == "October 2026")
        #expect(AgentBudgetUx.reset("2026-11-01T00:00:00+00:00") == "Nov 1")
    }

    @Test func parseLimit() {
        #expect(AgentBudgetUx.parseLimit("", integer: false) == .none)
        #expect(AgentBudgetUx.parseLimit("$1,250.456", integer: false) == .value(1250.46))
        #expect(AgentBudgetUx.parseLimit("2000000", integer: true) == .value(2_000_000))
        #expect(AgentBudgetUx.parseLimit("-3", integer: false) == .invalid)
        #expect(AgentBudgetUx.parseLimit("abc", integer: true) == .invalid)
    }

    @Test func budgetUpdateBodySendsExplicitNullToClear() {
        let body = AgentBudgetUpdate(usd: .clear, tokens: .set(5000)).json(actor: "h1")
        #expect(body["actor_agent_id"] as? String == "h1")
        #expect(body["monthly_limit_usd"].flatMap { $0 } is NSNull)
        #expect(body["monthly_limit_tokens"].flatMap { $0 } as? Int == 5000)
        #expect(body["override"] == nil)
        let grant = AgentBudgetUpdate(override: "grant", note: "launch week").json(actor: "h1")
        #expect(grant["override"].flatMap { $0 } as? String == "grant")
        #expect(grant["monthly_limit_usd"] == nil)
    }

    // MARK: reporting lines

    @Test func decodesReportsTo() throws {
        let r = try decode(ReportsToDto.self, """
        {"agent_id":"a1","reports_to_agent_id":"m1","reports_to_alias":"lead",
         "chain":[{"id":"m1","alias":"lead","kind":"ai","member_role":null,"terminated":false},
                  {"id":"h1","alias":"owner","kind":"human","member_role":"owner","terminated":false}]}
        """)
        #expect(r.reportsToAlias == "lead")
        #expect(r.chain.map(\.alias) == ["lead", "owner"])
        let none = try decode(ReportsToDto.self, #"{"agent_id":"a1","reports_to_agent_id":null,"reports_to_alias":null,"chain":[]}"#)
        #expect(none.reportsToAgentId == nil)
    }

    @Test func orgTreeIndentsReportsAndSurvivesCycles() {
        let nodes = AgentOrgUx.flatten(
            order: ["h", "a", "b", "c", "x", "y"],
            managerOf: ["a": "h", "b": "a", "c": "h", "x": "y", "y": "x"]
        )
        #expect(nodes.map(\.id) == ["h", "a", "b", "c", "x", "y"])
        #expect(nodes.map(\.depth) == [0, 1, 2, 1, 0, 0])
    }

    // MARK: live changes

    @Test func decodesChangesAndUnchanged() throws {
        let c = try decode(RunChangesDto.self, """
        {"available":true,"running":true,"run_status":"running","source":"live","root":"worktree","branch":"feat/x",
         "files":[{"path":"src/app.py","status":"M","additions":3,"deletions":1},
                  {"path":"assets/logo.png","status":"??","additions":null,"deletions":null}],
         "summary":{"files":2,"additions":3,"deletions":1},"truncated":false,"version":"v1","as_of":"2026-10-02T00:00:00Z"}
        """)
        #expect(c.files.count == 2)
        #expect(c.files[1].additions == nil)
        #expect(c.version == "v1")
        #expect(!c.unchanged)
        let u = try decode(RunChangesDto.self, #"{"unchanged":true,"version":"v1","running":true,"as_of":"x"}"#)
        #expect(u.unchanged)
        let off = try decode(RunChangesDto.self, #"{"available":false,"reason":"no_checkout","detail":"d","running":false,"files":[],"summary":{"files":0,"additions":0,"deletions":0}}"#)
        #expect(AgentChangesUx.unavailableCopy(off.reason, detail: off.detail) == "This run has no checkout to read changes from.")
    }

    @Test func changesCopy() {
        #expect(AgentChangesUx.isImage("assets/Logo.PNG"))
        #expect(!AgentChangesUx.isImage("Makefile"))
        #expect(!AgentChangesUx.isImage("src/png"))
        #expect(AgentChangesUx.statusLabel("??") == "Added")
        #expect(AgentChangesUx.statusLabel("R100") == "Renamed")
        #expect(AgentChangesUx.statusLabel("M") == "Modified")
        #expect(AgentChangesUx.fileName("a/b/c.swift") == "c.swift")
    }

    @Test func decodesRunDiff() throws {
        let d = try decode(RunDiffDto.self, #"{"available":true,"path":"a.py","diff":"@@ -1 +1 @@\n-a\n+b\n","binary":false,"truncated":false,"source":"live"}"#)
        #expect(d.available)
        #expect(d.diff?.contains("+b") == true)
    }

    // MARK: config history

    @Test func decodesRevisionsAndFormatsSentences() throws {
        let page = try decode(ConfigRevisionPageDto.self, """
        {"agent_id":"a1","latest_revision_no":3,"total":3,"next_before":null,"revisions":[
          {"revision_no":3,"kind":"restore","source":"api","restored_from":1,"reason":null,"redacted_fields":[],
           "actor":{"agent_id":"h1","alias":"hussein","kind":"human"},
           "changes":[{"field":"model","before":"opus","after":"sonnet"},{"field":"provider","before":"claude","after":"claude","derived":true}],
           "created_at":"2026-10-02T14:20:54Z"},
          {"revision_no":2,"kind":"change","source":"api","actor":null,
           "changes":[{"field":"auto_wake_interval_secs","before":null,"after":3600}],"created_at":null},
          {"revision_no":1,"kind":"initial","source":"backfill","changes":[],"actor":null,"restored_from":null,"reason":null,"redacted_fields":[],"created_at":"2026-10-02T14:20:54.728478+00:00"}]}
        """)
        #expect(page.latestRevisionNo == 3)
        #expect(page.revisions.count == 3)
        #expect(AgentConfigHistoryUx.sentence(page.revisions[0]) == "hussein restored model from #1")
        #expect(AgentConfigHistoryUx.sentence(page.revisions[1]) == "Unattributed changed auto-wake")
        #expect(AgentConfigHistoryUx.sentence(page.revisions[2]) == "Initial configuration captured")
        let wake = page.revisions[1].changes[0]
        #expect(AgentConfigHistoryUx.value(wake.field, wake.before) == "Off")
        #expect(AgentConfigHistoryUx.value(wake.field, wake.after) == "Hourly")
    }

    @Test func configValueCopy() {
        #expect(AgentConfigHistoryUx.value("autonomy_override", .null) == "Inherit project")
        #expect(AgentConfigHistoryUx.value("autonomy_override", .string("pr")) == "PR")
        #expect(AgentConfigHistoryUx.value("reasoning_effort", .string("high")) == "High")
        #expect(AgentConfigHistoryUx.value("auto_wake_interval_secs", .number(900)) == "Every 15 min")
        #expect(AgentConfigHistoryUx.value("role", .string("")) == "Not set")
    }

    @Test func decodesRevisionDetail() throws {
        let d = try decode(ConfigRevisionDetailDto.self, """
        {"revision_no":2,"kind":"change","changes":[],"snapshot":{},
         "restore_preview":[{"field":"model","current":"sonnet","target":"opus","grant":"manage_agents"}],
         "restore_blocked":[]}
        """)
        #expect(d.restorePreview.first?.target == .string("opus"))
        #expect(d.restoreBlocked.isEmpty)
    }
}
