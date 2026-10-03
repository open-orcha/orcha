import Foundation
import Testing
@testable import Orcha

/// Inbox slice: request extras decoding (mig 065 agent_payload split, auto-resolve),
/// human-text extraction, portal-link chips, notification prefs and routines.

@Suite struct InboxRequestExtrasTests {

    @Test func decodesDetailAndKeepsAgentPayloadSeparate() throws {
        let json = """
        {"requests":[{"id":"r1","payload":"Why is this slow?","agent_payload":"reply via POST /api/code/threads/x/messages",
          "detail":{"auto_resolved":"thread_answered","display_title":"Why · slow — a.ts L3",
                    "code_thread":{"thread_id":"t1","kind":"why","path":"a.ts","start_line":3,"end_line":3,"link":"/code?path=a.ts&thread=t1"}},
          "closed_by_alias":"atlas","close_decision":{"reason":"done","actor":"atlas","at":"2026-01-01T00:00:00Z"}}]}
        """
        let res = try JSONDecoder().decode(InboxRequestListResponse.self, from: Data(json.utf8))
        let r = try #require(res.requests.first)
        #expect(r.agentPayload?.contains("reply via POST") == true)
        #expect(r.detail?.autoResolved == "thread_answered")
        #expect(r.detail?.codeThread?.link == "/code?path=a.ts&thread=t1")
        #expect(r.closedByAlias == "atlas")
        #expect(r.closeDecision?.reason == "done")

        let human = InboxRequestText.humanize(payload: r.payload ?? "", detail: r.detail)
        #expect(human.question == "Why is this slow?")
        #expect(human.title == "Why · slow — a.ts L3")
        #expect(!human.question.contains("POST"))
    }

    @Test func oddDetailShapeNeverFailsTheRow() throws {
        let json = #"{"requests":[{"id":"r2","payload":"hi","detail":{"auto_resolved":42,"code_thread":"nope"}}]}"#
        let res = try JSONDecoder().decode(InboxRequestListResponse.self, from: Data(json.utf8))
        #expect(res.requests.first?.detail?.autoResolved == nil)
        #expect(res.requests.first?.agentPayload == nil)
    }

    @Test func legacyCombinedPayloadIsStripped() {
        let legacy = "[code thread — teach] local@8cf5234 deploy/docker-compose.yml:1-1\nExplain this file\n\nanswer as a short lesson in markdown …\n\nreply via POST /api/code/threads/abc/messages {…}\nview/reply in the portal: /code?path=deploy/docker-compose.yml&thread=abc"
        let human = InboxRequestText.humanize(payload: legacy, detail: nil)
        #expect(human.question == "Explain this file")
        #expect(human.threadLink == "/code?path=deploy/docker-compose.yml&thread=abc")
    }

    @Test func plainPayloadPassesThrough() {
        #expect(InboxRequestText.humanize(payload: "Ship it?", detail: nil).question == "Ship it?")
    }

    @Test func autoResolvedWording() {
        #expect(InboxRequestText.autoResolvedCopy("thread_resolved") == "Resolved automatically — the code thread was resolved")
        #expect(InboxRequestText.autoResolvedCopy("thread_answered") == "Resolved automatically — answered in the code thread")
        #expect(InboxRequestText.autoResolvedCopy(nil) == nil)
        #expect(InboxRequestText.closedCopy(closedBy: "lead", reason: "dup") == "lead closed it — dup")
        #expect(InboxRequestText.closedCopy(closedBy: nil, reason: nil) == "Closed — no further action")
    }
}

@Suite struct PortalLinkTests {

    @Test func bareTaskPathBecomesTaskLink() {
        let m = PortalLinks.matches(in: "see /tasks?task=abc12345 for details.", baseURL: nil)
        #expect(m.count == 1)
        #expect(m.first?.link.target == .task("abc12345"))
        #expect(m.first?.link.label() == "Open task abc12345")
    }

    @Test func trailingPunctuationStaysOutside() {
        let text = "(/requests?req=0123456789abcdef)."
        let m = PortalLinks.matches(in: text, baseURL: nil)
        #expect(m.first?.link.path == "/requests?req=0123456789abcdef")
        #expect(m.first?.link.label() == "Open request 01234567")
    }

    @Test func longerPathsAndMidWordDoNotMatch() {
        #expect(PortalLinks.matches(in: "run /codex now", baseURL: nil).isEmpty)
        #expect(PortalLinks.matches(in: "a/tasks?task=x", baseURL: nil).isEmpty)
        #expect(PortalLinks.matches(in: "/code/foo", baseURL: nil).isEmpty)
    }

    @Test func absoluteUrlOnPairedHostIsPortalLink() {
        let text = "open http://100.64.0.2:8001/agents?agent=atlas please"
        let m = PortalLinks.matches(in: text, baseURL: "http://100.64.0.2:8001")
        #expect(m.count == 1)
        #expect(m.first?.link.target == .agent(alias: "atlas"))
        #expect(m.first?.link.label() == "Open agent atlas")
        // other hosts are not portal links
        #expect(PortalLinks.matches(in: "http://example.com/tasks?task=x", baseURL: "http://100.64.0.2:8001").isEmpty)
    }

    @Test func codeAndGithubLabels() {
        #expect(PortalLinks.parse("/code?path=a/b.ts&thread=t")?.label() == "Open thread in Code")
        #expect(PortalLinks.parse("/code?path=a/b.ts")?.label() == "Open b.ts in Code")
        #expect(PortalLinks.parse("/github?pr=12")?.target == .githubPull(12))
        #expect(PortalLinks.parse("/github?issue=7")?.label() == "Open issue #7")
        #expect(PortalLinks.parse("/routines")?.label() == "Open Routines")
        #expect(PortalLinks.parse("/routines")?.target == .web)
    }

    @Test func rewriteReplacesPathWithLabelLink() {
        let text = "go to /tasks?task=abc now"
        let out = PortalLinks.rewrite(text, baseURL: nil, tasks: [], base: AttributedString(text))
        let plain = String(out.characters)
        #expect(plain == "go to ↗ Open task abc now")
        let link = out.runs.compactMap(\.link).first
        #expect(link.flatMap(PortalLinks.link(fromURL:))?.path == "/tasks?task=abc")
    }

    @Test func linksDedupeAcrossTexts() {
        let links = PortalLinks.links(in: ["/agents?agent=a", "again /agents?agent=a and /needs"], baseURL: nil)
        #expect(links.map(\.path) == ["/agents?agent=a", "/needs"])
    }
}

@MainActor
@Suite struct ResolveUndoTests {

    @Test func undoCancelsTheClose() async throws {
        let q = ResolveUndoQueue(delay: .milliseconds(80))
        var sent = false
        q.schedule("r1") { sent = true }
        #expect(q.isResolving("r1"))
        #expect(q.undo("r1"))
        try await Task.sleep(for: .milliseconds(200))
        #expect(!sent)
        #expect(!q.isResolving("r1"))
        #expect(!q.undo("r1"))
    }

    @Test func closeIsSentAfterTheWindow() async throws {
        let q = ResolveUndoQueue(delay: .milliseconds(30))
        var sent = 0
        q.schedule("r1") { sent += 1 }
        try await Task.sleep(for: .milliseconds(300))
        #expect(sent == 1)
        #expect(!q.isResolving("r1"))
    }

    @Test func flushSendsPendingClosesOnceAndNow() async throws {
        let q = ResolveUndoQueue(delay: .seconds(60))
        var sent = 0
        q.schedule("r1") { sent += 1 }
        await q.flushAll()
        #expect(sent == 1)
        #expect(!q.isResolving("r1"))
        #expect(!q.undo("r1"))
    }
}

@Suite struct NotificationPrefsTests {

    static let payload = """
    {"member":{"id":"m","alias":"h","member_role":"owner"},
     "catalog":{"categories":[{"key":"budget","label":"Budget alerts","description":"Spend warnings and hard stops."}],
       "channels":[{"key":"in_app","label":"In-app","alert":false},{"key":"push","label":"Mobile push","alert":true}],
       "scopes":[{"key":"all","label":"All"},{"key":"mine","label":"Only mine"},{"key":"off","label":"Off"}],
       "presets":[],"locks":[{"category":"budget","channel":"in_app","reason":"Budget hard stops always show in the app."}],
       "kinds":{"budget_paused":"budget"}},
     "channels":{"in_app":{"available":true,"reason":null},"push":{"available":false,"reason":"No phone is set up for push."}},
     "defaults":{"rules":{"budget":{"scope":"all","channels":{"in_app":true,"push":true}}},"pause":{"until":null},"quiet_hours":{"start":"22:00","end":"07:00","tz":"Europe/London"},"stored":true},
     "project":{"rules":{"budget":{"scope":"mine"}},"muted":false,"stored":true},
     "effective":{"rules":{"budget":{"scope":"mine","channels":{"in_app":true,"push":true}}},"pause":{"until":null},"quiet_hours":null,"muted":false,"paused_now":true,"quiet_now":false},
     "editable":true}
    """

    @Test func decodesThePrefsPayload() throws {
        let p = try JSONDecoder().decode(NotificationPrefsDto.self, from: Data(Self.payload.utf8))
        #expect(p.catalog.categories.first?.label == "Budget alerts")
        #expect(p.channels["push"]?.available == false)
        #expect(p.defaults.pause == NotifPause(until: nil))
        #expect(p.defaults.quietHours?.tz == "Europe/London")
        #expect(p.project.rules["budget"]?.scope == "mine")
        #expect(p.project.rules["budget"]?.channels == nil)
        #expect(p.effective.pausedNow)
        #expect(NotificationPrefsUx.lockReason(p.catalog, category: "budget", channel: "in_app") != nil)
        #expect(NotificationPrefsUx.lockReason(p.catalog, category: "budget", channel: "push") == nil)
    }

    @Test func nullPauseDecodesAsNotPaused() throws {
        let json = #"{"rules":{},"pause":null,"quiet_hours":null,"stored":false}"#
        let d = try JSONDecoder().decode(NotifDefaults.self, from: Data(json.utf8))
        #expect(d.pause == nil)
        #expect(!NotificationPrefsUx.isPaused(d.pause))
    }

    @Test func pauseChoices() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_700_000_000) // 2023-11-14 22:13:20 UTC
        #expect(NotificationPrefsUx.pause(for: .oneHour, now: now, calendar: cal).until == 1_700_003_600)
        #expect(NotificationPrefsUx.pause(for: .forever, now: now, calendar: cal).until == nil)
        let tomorrow = NotificationPrefsUx.pause(for: .tomorrow, now: now, calendar: cal).until!
        #expect(tomorrow == 1_700_035_200) // 2023-11-15 08:00 UTC
        #expect(NotificationPrefsUx.isPaused(NotifPause(until: nil), now: now))
        #expect(!NotificationPrefsUx.isPaused(NotifPause(until: 1_600_000_000), now: now))
        #expect(NotificationPrefsUx.pauseText(NotifPause(until: nil), now: now) == "Paused until you turn them back on")
        let text = NotificationPrefsUx.pauseText(NotifPause(until: tomorrow), now: now, calendar: cal, locale: Locale(identifier: "en_US"))
        #expect(text?.hasPrefix("Paused until tomorrow, ") == true)
    }

    @Test func projectRulesCarryTheRestOver() {
        let current: [String: NotifPartialRule] = ["tasks": NotifPartialRule(scope: "off", channels: nil)]
        let out = NotificationPrefsUx.projectRules(current, category: "budget", channel: "push", on: false)
        #expect(out["tasks"]?.scope == "off")
        #expect(out["budget"]?.channels == ["push": false])
        #expect(out["budget"]?.scope == nil)
        let scoped = NotificationPrefsUx.projectRules(out, category: "budget", scope: "mine")
        #expect(scoped["budget"] == NotifPartialRule(scope: "mine", channels: ["push": false]))
    }

    @Test func partialRuleEncodesWithoutNulls() throws {
        let obj = try OrchaApiClient.jsonObject(["budget": NotifPartialRule(scope: nil, channels: ["push": true])]) as? [String: Any]
        let budget = obj?["budget"] as? [String: Any]
        #expect(budget?.keys.contains("scope") == false)
        #expect((budget?["channels"] as? [String: Bool]) == ["push": true])
    }

    @Test func quietHourTimes() {
        #expect(NotificationPrefsUx.minutes("22:30") == 1350)
        #expect(NotificationPrefsUx.minutes("25:00") == nil)
        #expect(NotificationPrefsUx.hhmm(1350) == "22:30")
        #expect(NotificationPrefsUx.hhmm(0) == "00:00")
    }
}

@Suite struct RoutineTests {

    @Test func decodesTheRoutineList() throws {
        let json = """
        {"routines":[{"id":"r1","container_id":"c","title":"Weekly audit {{date}}","title_preview":"Weekly audit 2026-10-05",
          "description":null,"definition_of_done":"x","assignee_agent_id":null,"assignee_alias":"atlas","assignee_retired":false,
          "priority":2,"cron":"0 9 * * 1","timezone":"Europe/London","schedule_text":"Every Monday at 09:00","enabled":true,
          "skip_if_open":true,"next_run_at":"2026-10-05T08:00:00+00:00","last_run_at":null,
          "last_run":{"run_id":"u","outcome":"created","trigger":"manual","detail":null,"created_at":"2026-10-01T08:00:00+00:00",
                      "task_id":"t","task_status":"in_progress","task_title":"Weekly audit","missed_count":0}}],
         "scheduler":{"last_tick_at":"2026-10-02T14:20:18.229485+00:00"}}
        """
        let res = try JSONDecoder().decode(RoutineListResponse.self, from: Data(json.utf8))
        let r = try #require(res.routines.first)
        #expect(r.displayTitle == "Weekly audit 2026-10-05")
        #expect(r.scheduleText == "Every Monday at 09:00")
        #expect(r.lastRun?.taskStatus == "in_progress")
        #expect(res.scheduler?.lastTickAt != nil)
    }

    @Test func decodesRuns() throws {
        let json = #"{"runs":[{"run_id":"u","routine_id":"r","trigger":"catch_up","scheduled_for":null,"missed_count":3,"outcome":"skipped","task_id":null,"task_title":null,"task_status":null,"detail":"previous task still open","actor_alias":null,"created_at":"2026-10-01T08:00:00Z","finished_at":null}]}"#
        let res = try JSONDecoder().decode(RoutineRunsResponse.self, from: Data(json.utf8))
        let run = try #require(res.runs.first)
        #expect(RoutineUx.triggerWord(trigger: run.trigger, missedCount: run.missedCount, actorAlias: nil) == "Catch-up (3 missed)")
        #expect(RoutineUx.lastResult(outcome: run.outcome, taskId: nil, taskStatus: nil).text == "Skipped")
    }

    @Test func copy() {
        #expect(RoutineUx.lastResult(outcome: nil, taskId: nil, taskStatus: nil).text == "Never run")
        #expect(RoutineUx.lastResult(outcome: "created", taskId: nil, taskStatus: nil).text == "Task removed")
        let done = RoutineUx.lastResult(outcome: "created", taskId: "t", taskStatus: "completed")
        #expect(done.text == "Done")
        #expect(done.tone == .ok)
        #expect(RoutineUx.lastResult(outcome: "failed", taskId: nil, taskStatus: nil).tone == .danger)
        #expect(RoutineUx.triggerWord(trigger: "manual", missedCount: 0, actorAlias: "hussein") == "Run now by hussein")
        #expect(RoutineUx.triggerWord(trigger: "schedule", missedCount: 0, actorAlias: nil) == "Scheduled")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        #expect(RoutineUx.nextRunText(enabled: false, nextRunAt: nil, now: now) == "Paused")
        #expect(RoutineUx.nextRunText(enabled: true, nextRunAt: nil, now: now) == "No upcoming run")
        #expect(RoutineUx.nextRunText(enabled: true, nextRunAt: "2023-11-15T01:13:20Z", now: now) == "Next run in 3h")
        #expect(RoutineUx.runResultToast(detail: nil) == "Task created.")
    }
}
