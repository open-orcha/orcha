import Foundation
import Testing
@testable import Orcha

/// Project slice: objective / limits / budgets / metrics / worktrees / routine decoding,
/// the routine schedule presets ⇄ cron, and the metrics figure rules.

@Suite struct ProjectSliceDecodingTests {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func decodesLimits() throws {
        let l = try decode(ContainerLimitsDto.self, """
        {"container_id":"c","max_auto_agents":12,"auto_agents_in_use":3,"min_max_auto_agents":1,"max_max_auto_agents":50}
        """)
        #expect(l.maxAutoAgents == 12)
        #expect(l.autoAgentsInUse == 3)
        #expect(ProjectLimitsUx.clampLimit(99, l) == 50)
        #expect(ProjectLimitsUx.clampLimit(0, l) == 1)
    }

    @Test func limitsFallBackToDefaultRange() throws {
        let l = try decode(ContainerLimitsDto.self, #"{"max_auto_agents":5}"#)
        #expect(l.minMaxAutoAgents == 1 && l.maxMaxAutoAgents == 50 && l.autoAgentsInUse == 0)
    }

    @Test func decodesProjectBudget() throws {
        let b = try decode(ProjectBudgetsDto.self, """
        {"period":"2026-10","resets_at":"2026-11-01T00:00:00+00:00",
         "project":{"limits":{"usd":50.0,"tokens":null},"usage":{"spend_usd":12.5,"metered_runs":3,"unmetered_runs":0,"tokens":1000,"runs":3,"in_flight_runs":0},
                    "state":"ok","usd_ratio":0.25,"paused":false,"override":{"active":false,"note":null}},
         "agents":[{"agent_id":"a1","alias":"atlas","limits":{"usd":null,"tokens":null},"state":"none"}]}
        """)
        #expect(b.project?.limits.usd == 50)
        #expect(b.project?.usage.spendUsd == 12.5)
        #expect(b.agents.first?.alias == "atlas")
    }

    @Test func decodesObjective() throws {
        let o = try decode(ContainerObjectiveDto.self, #"{"container_id":"c","objective":null}"#)
        #expect(o.objective == nil)
    }

    @Test func decodesPerformance() throws {
        let metrics = """
        {"tasks_verified":4,"first_pass_rate":{"value":0.75,"numerator":3,"denominator":4,"enough":true},
         "rework":{"total":1,"human_rejections":1,"manager_send_backs":0},
         "median_time_to_verified_seconds":{"value":5400,"n":4,"enough":true},
         "cost_per_verified_task_usd":{"value":null,"metered_tasks":0,"unmetered_tasks":4,"total_metered_usd":null,"enough":false},
         "plan_approval_rate":{"value":null,"numerator":1,"denominator":1,"enough":false,"approved":1,"rejected":0},
         "escalations":2}
        """
        let p = try decode(PerformanceDto.self, """
        {"range":"7d","since":null,"bucket_days":1,"min_sample":3,"generated_at":"x",
         "project":{"container_id":"c","name":"p","metrics":\(metrics),"series":[{"start":"2026-10-01T00:00:00+00:00","end":"2026-10-02T00:00:00+00:00","verified":2,"rework":1}]},
         "agents":[{"agent_id":"a1","alias":"atlas","model":"m","role":null,"retired":false,"metrics":\(metrics),"series":[]}]}
        """)
        let m = p.project.metrics
        #expect(p.project.series.first?.verified == 2)
        #expect(p.agents.first?.alias == "atlas")
        #expect(PerfUx.firstPass(m) == PerfUx.Figure(text: "75%", known: true, sub: "3 of 4 verified tasks"))
        #expect(PerfUx.median(m).text == "1.5h")
        #expect(PerfUx.costPerVerified(m).text == PerfUx.notMetered)
        #expect(PerfUx.planApproval(m).text == PerfUx.notEnough)
        #expect(PerfUx.firstPassTone(m) == .warn)
    }

    @Test func decodesWorktrees() throws {
        let w = try decode(AgentWorktreesDto.self, """
        {"container_id":"c","settings":{"auto_cleanup":true,"grace_days":7},
         "inventory":{"host":"h","base_cwd":"/x","scanned_at":"2026-10-02T14:50:38Z",
           "items":[{"path":"/x/.orcha-worktrees/a","name":"a","branch":"b","kind":"wake","agent":"atlas","state":"clean","size_bytes":2048}],
           "counts":{"clean":1},"reclaimable_bytes":2048,"total_bytes":2048},
         "actions":[]}
        """)
        #expect(w.settings.graceDays == 7)
        #expect(w.inventory?.items.first?.state == "clean")
        #expect(ProjectLimitsUx.worktreeState("has-output") == "Has output")
        #expect(ProjectLimitsUx.clampGrace(120) == 90)
    }

    @Test func worktreesWithoutInventory() throws {
        let w = try decode(AgentWorktreesDto.self, #"{"settings":{"auto_cleanup":false,"grace_days":0},"inventory":null,"actions":[]}"#)
        #expect(w.inventory == nil)
        let a = try decode(WorktreeActionDto.self, #"{"id":"x","action":"clean_up","status":"claimed","error":null}"#)
        #expect(a.pending)
    }

    @Test func decodesRoutineRead() throws {
        let r = try decode(RoutineReadDto.self, """
        {"id":"r1","container_id":"c","title":"Audit {{date}}","title_preview":"Audit 2026-10-02","description":null,
         "definition_of_done":"Report posted","assignee_agent_id":"a1","assignee_alias":"atlas","priority":10,
         "cron":"30 8 * * 1","timezone":"Africa/Nairobi","schedule_text":"Every Monday at 08:30 Nairobi time",
         "enabled":true,"skip_if_open":false,"next_run_at":null}
        """)
        #expect(r.priority == 10)
        #expect(r.cron == "30 8 * * 1")
        #expect(!r.skipIfOpen)
    }

    @Test func routineInputSendsExplicitNulls() {
        let input = RoutineInput(title: "T", description: nil, definitionOfDone: "D", assigneeAgentId: nil,
                                 priority: 100, cron: "0 9 * * *", timezone: "UTC", enabled: true, skipIfOpen: true)
        let body = input.json(actor: "h1")
        #expect(body["assignee_agent_id"] is NSNull)
        #expect(body["description"] is NSNull)
        #expect(body["actor_agent_id"] as? String == "h1")
    }
}

@Suite struct RoutineScheduleTests {

    @Test(arguments: [
        ("15 * * * *", RoutineSchedulePreset.hourly),
        ("0 9 * * *", .daily),
        ("0 9 * * 1-5", .weekdays),
        ("30 8 * * 1", .weekly),
        ("0 6 15 * *", .monthly),
        ("*/30 9-17 * * 1-5", .custom),
        ("0 9 31 * *", .custom),
    ])
    func presetRoundTrip(cron: String, preset: RoutineSchedulePreset) {
        let form = RoutineScheduleUx.fromCron(cron)
        #expect(form.preset == preset)
        #expect(RoutineScheduleUx.toCron(form) == cron)
    }

    @Test func weeklySundayAsSeven() {
        let form = RoutineScheduleUx.fromCron("0 9 * * 7")
        #expect(form.preset == .weekly)
        #expect(form.weekday == 0)
    }

    @Test func describeMatchesServerWording() {
        #expect(RoutineScheduleUx.describe("0 9 * * 1-5", timezone: "Africa/Nairobi") == "Every weekday at 09:00 Nairobi time")
        #expect(RoutineScheduleUx.describe("5 * * * *", timezone: "UTC") == "Every hour at :05")
        #expect(RoutineScheduleUx.describe("0 6 2 * *", timezone: "UTC") == "On the 2nd of every month at 06:00 UTC")
        #expect(RoutineScheduleUx.describe("0 9 * * 0", timezone: "America/New_York") == "Every Sunday at 09:00 New York time")
    }

    @Test func cronShapeCheck() {
        #expect(RoutineScheduleUx.looksLikeCron("  0  9 * * 1-5 "))
        #expect(!RoutineScheduleUx.looksLikeCron("0 9 * *"))
        #expect(RoutineScheduleUx.normalize("0   9 *\t* *") == "0 9 * * *")
    }

    @Test func metricsFormatting() {
        #expect(PerfUx.span(45) == "45s")
        #expect(PerfUx.span(720) == "12m")
        #expect(PerfUx.span(86400 * 2) == "2d")
        #expect(PerfUx.cost(0.005) == "$0.005")
        #expect(PerfUx.cost(12.345) == "$12.35")
        #expect(PerfUx.cost(250) == "$250")
        #expect(ProjectLimitsUx.agentLimitDesc(inUse: 3) == "Suggested agents that can be created in this project — 3 in use")
    }
}
