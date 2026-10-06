import Foundation
import Testing
@testable import Orcha

/// Task-detail parity slice: evidence pack / Verdikt / goal chain / routine / assign DTO
/// decoding, plus the pure presentation logic ported from the web portal.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct TaskParityDecodingTests {

    @Test func evidencePackDecodesTheWebShape() throws {
        let pack = try decode(EvidencePackDto.self, """
        {"task_id":"t1","task_status":"needs_verification","built_at":"2026-10-01T10:00:00Z",
         "round_started_at":null,
         "runs":[{"run_id":"r1","agent_alias":"forge","status":"finished","exit_code":0}],
         "tests":{"status":"passed","passed":42,"failed":0,"skipped":1,"errors":0,"suites":3,
                  "latest":[{"run_id":"r1","framework":"npm test (node:test)","command":"npm test",
                             "exit_code":0,"counts":{"passed":42,"failed":0,"skipped":1,"errors":0,
                             "total":43,"unit":"tests","source":"x"},"outcome":"passed"}],"earlier":2},
         "changes":{"files":3,"additions":40,"deletions":2,"summary":"3 files changed","flags":[]},
         "flags":[{"kind":"migration","label":"Migration","detail":"Touches a DB migration",
                   "severity":"warn","files":["db/001.sql"],"count":1}],
         "branch":"feat/x","pr_urls":["https://github.com/o/r/pull/9"],
         "links":[{"kind":"pr","label":"PR #9","href":"https://github.com/o/r/pull/9"},
                  {"kind":"runs","label":"Runs (1)","href":"/tasks?task=t1&tab=runs"}],
         "dod":{"items":[{"index":0,"text":"Tests pass","status":"proven","basis":"tests",
                          "evidence":"42 passed","claim":"all green"},
                         {"index":1,"text":"Looks right","status":"needs_human","basis":"none","evidence":null}],
                "total":2,"proven":1,"not_proven":0,"needs_human":1},
         "verdikt":{"id":"v1","task_id":"t1","trigger":"auto","status":"completed","verdict":"pass",
                    "report_url":"/api/tasks/t1/verdikt/runs/v1/report","criteria":[],"screenshots":[],
                    "handoff":{},"target_kind":"web","locator":"http://x"},
         "summary":{"dod":{"total":2,"proven":1,"not_proven":0,"needs_human":1},
                    "tests":{"status":"passed","passed":42,"failed":0,"skipped":1,"errors":0,"suites":3},
                    "risk_flags":1,"verdikt":{"status":"completed","verdict":"pass"},"line":"x","autofix":null},
         "autofix":null,"rebuilt":false}
        """)
        #expect(pack.dod?.items.count == 2)
        #expect(pack.dod?.items.first?.claim == "all green")
        #expect(pack.tests?.latest.first?.counts?.passed == 42)
        #expect(pack.tests?.earlier == 2)
        #expect(pack.flags.first?.label == "Migration")
        #expect(pack.verdikt?.verdict == "pass")
        #expect(pack.verdikt?.reportUrl == "/api/tasks/t1/verdikt/runs/v1/report")
        #expect(pack.summary?.riskFlags == 1)
        #expect(pack.links.count == 2)
    }

    @Test func evidencePackToleratesASparseOlderPayload() throws {
        let pack = try decode(EvidencePackDto.self, #"{"task_id":"t1"}"#)
        #expect(pack.runs.isEmpty)
        #expect(pack.dod == nil)
        #expect(EvidenceUx.summaryParts(pack.summary).isEmpty)
    }

    @Test func goalChainDecodes() throws {
        let chain = try decode(GoalChainDto.self, """
        {"task_id":"t3","goal_chain":[
          {"kind":"objective","id":"root","title":"orcha-open","text":"Ship v1","source":"root_task"},
          {"kind":"parent","id":"t2","title":"Parent","status":"in_progress","via":"parent_link"},
          {"kind":"task","id":"t3","title":"Child","status":"ready"}],
         "truncated":false,"cycle":false}
        """)
        #expect(chain.goalChain.count == 3)
        #expect(GoalChainUx.crumbs(chain) == [
            .objective(text: "Ship v1", projectTitle: "orcha-open"),
            .parent(id: "t2", title: "Parent", status: "in_progress"),
            .this,
        ])
    }

    @Test func routineAndAssignAndPreviewDecode() throws {
        let preview = try decode(TaskRoutinePreviewDto.self, """
        {"valid":true,"error":null,"schedule_text":"Every weekday at 09:00","next_runs":["2026-10-05T09:00:00+03:00"]}
        """)
        #expect(preview.valid)
        #expect(preview.nextRuns.count == 1)
        let invalid = try decode(TaskRoutinePreviewDto.self, #"{"valid":false,"error":"bad cron","schedule_text":null,"next_runs":[]}"#)
        #expect(!invalid.valid && invalid.error == "bad cron")
        let created = try decode(TaskRoutineCreatedDto.self, #"{"id":"r1","schedule_text":"Every day at 09:00","cron":"0 9 * * *"}"#)
        #expect(created.scheduleText == "Every day at 09:00")
        let assigned = try decode(AssignResultDto.self, #"{"task_id":"t","agent_id":"a","alias":"forge","status":"ready","assignment_status":"assigned","woke":true,"released_prior":["b"]}"#)
        #expect(assigned.alias == "forge" && assigned.woke == true)
    }

    @Test func verdiktRunsAndManagerReviewDecode() throws {
        let runs = try decode(VerdiktRunsResponse.self, """
        {"task_id":"t","settings":{"configured":true,"enabled":true,"base_url":"http://v"},"runs":[],"autofix":null}
        """)
        #expect(runs.settings?.enabled == true)
        let rows = try decode([TaskReviewExtrasDto].self, """
        [{"id":"t","manager_review":{"status":"approved","manager_alias":"atlas","reasons":"covers the DoD"}},
         {"id":"u","manager_review":null}]
        """)
        #expect(rows.first?.managerReview?.managerAlias == "atlas")
        #expect(rows.last?.managerReview == nil)
    }
}

@Suite struct TaskParityLogicTests {

    @Test func summaryPartsMirrorTheWebLine() {
        let s = EvidenceSummaryDto(
            dod: EvidenceDodCounts(total: 4, proven: 3, notProven: 0, needsHuman: 1),
            tests: EvidenceTestsDto(status: "passed", passed: 42),
            riskFlags: 1,
            verdikt: VerdiktBriefDto(status: "completed", verdict: "pass")
        )
        #expect(EvidenceUx.summaryParts(s).map(\.text) == [
            "3/4 DoD items evidenced", "42 tests passed", "1 risk flag", "Verdikt pass",
        ])
        #expect(EvidenceUx.summaryParts(s, short: true).map(\.text) == [
            "3/4 DoD", "42 tests passed", "1 risk", "Verdikt pass",
        ])
    }

    @Test func summaryTonesAndFailures() {
        let s = EvidenceSummaryDto(
            dod: EvidenceDodCounts(total: 2, proven: 1, notProven: 1),
            tests: EvidenceTestsDto(status: "failed", passed: 3, failed: 1, errors: 1),
            verdikt: VerdiktBriefDto(status: "running")
        )
        let parts = EvidenceUx.summaryParts(s)
        #expect(parts[0].tone == .bad)
        #expect(parts[1].text == "2 tests failing")
        #expect(parts[2].text == "Verdikt running")
        let none = EvidenceUx.summaryParts(EvidenceSummaryDto(tests: EvidenceTestsDto(status: "none")))
        #expect(none.map(\.text) == ["no tests ran"])
    }

    @Test func invocationText() {
        var inv = TestInvocationDto(framework: "vitest", command: "npx vitest", exitCode: 1,
                                    counts: TestCountsDto(passed: 5, failed: 2, skipped: 1), outcome: "failed")
        #expect(EvidenceUx.invocationText(inv).text == "5 passed · 2 failed · 1 skipped")
        #expect(EvidenceUx.invocationText(inv).tone == .bad)
        inv.counts = nil
        inv.outcome = "exit_failed"
        #expect(EvidenceUx.invocationText(inv).text == "exit 1")
    }

    @Test func managerReviewLine() {
        let approved = ManagerReviewDto(status: "approved", managerAlias: "atlas", reasons: "covers the DoD")
        #expect(ManagerReviewUx.line(approved)?.text == "atlas (manager) recommends approval: covers the DoD")
        #expect(ManagerReviewUx.line(approved)?.tone == .ok)
        #expect(ManagerReviewUx.line(ManagerReviewDto(status: "sent_back", managerAlias: "atlas", reasons: "x"))?.text
                == "atlas (manager) sent it back: x")
        #expect(ManagerReviewUx.line(nil) == nil)
    }

    @Test func goalChainFoldsFarParents() {
        let chain = GoalChainDto(goalChain: [
            GoalNodeDto(kind: "objective", title: "proj"),
            GoalNodeDto(kind: "parent", id: "p1", title: "Far"),
            GoalNodeDto(kind: "parent", id: "p2", title: "Mid"),
            GoalNodeDto(kind: "parent", id: "p3", title: "Near"),
            GoalNodeDto(kind: "task", id: "t", title: "Me"),
        ])
        let crumbs = GoalChainUx.crumbs(chain)
        #expect(crumbs.count == 5)
        #expect(crumbs[0] == .objective(text: nil, projectTitle: "proj"))
        #expect(crumbs[1] == .gap(label: "…", hint: "1 more parent task: Far"))
        #expect(crumbs[2] == .parent(id: "p2", title: "Mid", status: nil))
        #expect(crumbs.last == .this)
        #expect(!GoalChainUx.isWorthShowing([.this]))
        // Bare project, no objective, no parent: the page breadcrumb already covers it.
        #expect(!GoalChainUx.isWorthShowing([.objective(text: nil, projectTitle: "p"), .this]))
        #expect(GoalChainUx.isWorthShowing([.objective(text: "Ship v1", projectTitle: "p"), .this]))
        #expect(ManagerReviewUx.via(ReviewRoutingDto(routedVia: "reports_to", managerDepth: 1, assigneeAlias: "Atlas")) == "via Atlas’s manager")
    }

    @Test func cronPresets() {
        #expect(TaskRoutineUx.cron(.daily, hour: 7, minute: 30, weekday: 1) == "30 7 * * *")
        #expect(TaskRoutineUx.cron(.weekdays, hour: 9, minute: 0, weekday: 1) == "0 9 * * 1-5")
        #expect(TaskRoutineUx.cron(.weekly, hour: 16, minute: 0, weekday: 5) == "0 16 * * 5")
        #expect(TaskRoutineUx.describe(.weekly, hour: 16, minute: 5, weekday: 0) == "Every Sunday at 16:05")
    }

    @Test func routineDraftCopiesTheTaskAndOnlyAnAIAssignee() throws {
        let task = try decode(TaskDto.self, """
        {"id":"t1","title":"Audit deps","description":"  ","definition_of_done":"- report","priority":20,
         "assignees":["forge"],"status":"in_progress"}
        """)
        let agents = try decode([AgentDto].self, """
        [{"id":"a1","alias":"forge","kind":"ai"},{"id":"h1","alias":"maya","kind":"human"}]
        """)
        let draft = TaskRoutineUx.draft(from: task, agents: agents, cron: "0 9 * * 1-5", timezone: "Africa/Nairobi", skipIfOpen: true)
        #expect(draft.assigneeAgentId == "a1")
        #expect(draft.description == nil)
        #expect(draft.priority == 20)
        #expect(draft.originTaskId == "t1")
        let humanTask = try decode(TaskDto.self, #"{"id":"t2","title":"x","assignees":["maya"]}"#)
        #expect(TaskRoutineUx.draft(from: humanTask, agents: agents, cron: "", timezone: "UTC", skipIfOpen: false).assigneeAgentId == nil)
    }

    @Test func reassignCandidatesAndGate() throws {
        let agents = try decode([AgentDto].self, """
        [{"id":"a2","alias":"zed","kind":"ai"},{"id":"a1","alias":"atlas","kind":"ai"},
         {"id":"a3","alias":"gone","kind":"ai","terminated_at":"2026-01-01T00:00:00Z"},
         {"id":"h1","alias":"maya","kind":"human"}]
        """)
        #expect(ReassignUx.candidates(agents).map(\.alias) == ["atlas", "zed"])
        let done = try decode(TaskDto.self, #"{"id":"t","title":"x","status":"completed"}"#)
        let ready = try decode(TaskDto.self, #"{"id":"t","title":"x","status":"ready"}"#)
        #expect(!ReassignUx.canReassign(done))
        #expect(ReassignUx.canReassign(ready))
    }
}
