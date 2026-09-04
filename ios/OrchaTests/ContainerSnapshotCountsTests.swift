import Foundation
import Testing
@testable import Orcha

/// GH sidebar/iOS count mismatch — the founder saw the same "0 vs 62" style disagreement
/// on iOS he saw on the web portal, and suspected pagination: `ContainerHealth.tasks` (the
/// "N agents · N tasks" line on the Containers-home card) was `snap.tasks.count` — the
/// length of the capped/priority-ordered snapshot array — while other surfaces (the web
/// portal's sidebar/header, before its own fix) used differing status-filtered semantics.
///
/// Fix: `ContainerSnapshot.taskOpenTotal`/`.requestOpenTotal` (Data/Dtos.swift) prefer the
/// additive server fields `task_open_total`/`request_open_total` (container_snapshot_
/// routes.py — mirrors the web fix) and fall back to filtering the loaded `tasks`/
/// `requests` arrays when polling an older server that predates the fields. This is a 1:1
/// port of the portal's `taskOpenTotal()`/`requestOpenTotal()` (app-data.js) contract.
@Suite struct ContainerSnapshotCountsTests {
    private let decoder = JSONDecoder()

    // A minimal-but-valid container payload, interpolated with the tasks/requests/total
    // fields under test.
    private func snapshotJSON(
        tasks: String = "[]", requests: String = "[]",
        taskOpenTotal: String = "null", requestOpenTotal: String = "null"
    ) -> String {
        """
        {
          "container": {"id": "c1", "name": "quantal-health", "status": "active"},
          "agents": [],
          "tasks": \(tasks),
          "requests": \(requests),
          "task_open_total": \(taskOpenTotal),
          "request_open_total": \(requestOpenTotal)
        }
        """
    }

    // MARK: additive field present -> used verbatim (server total wins over the array)

    @Test func taskOpenTotalPrefersTheServerFieldOverTheLoadedArray() throws {
        // 3 tasks loaded (a capped window), but the server's true open total is 62 —
        // exactly the production shape (header "62 tasks", a much smaller loaded page).
        let json = snapshotJSON(
            tasks: #"[{"id":"t1","title":"a","status":"in_progress"},{"id":"t2","title":"b","status":"ready"},{"id":"t3","title":"c","status":"completed"}]"#,
            taskOpenTotal: "62"
        )
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.taskOpenTotal == 62, "the server field wins even though only 3 tasks are in the loaded array")
    }

    @Test func requestOpenTotalPrefersTheServerFieldOverTheLoadedArray() throws {
        let json = snapshotJSON(
            requests: #"[{"id":"r1","status":"open"}]"#,
            requestOpenTotal: "4"
        )
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.requestOpenTotal == 4)
    }

    // MARK: additive field absent (older server) -> graceful fallback over the loaded array

    @Test func taskOpenTotalFallsBackToFilteringTheLoadedArrayWhenFieldIsAbsent() throws {
        // task_open_total/request_open_total entirely missing from the payload (a
        // pre-fix server), not merely null — proves decoding tolerates the key's absence.
        let json = """
        {
          "container": {"id": "c1", "name": "quantal-health", "status": "active"},
          "agents": [],
          "tasks": [
            {"id": "t1", "title": "a", "status": "in_progress"},
            {"id": "t2", "title": "b", "status": "ready"},
            {"id": "t3", "title": "c", "status": "blocked"},
            {"id": "t4", "title": "d", "status": "completed"},
            {"id": "t5", "title": "e", "status": "cancelled"}
          ],
          "requests": []
        }
        """
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.taskOpenTotal == 3, "3 non-terminal tasks (in_progress/ready/blocked); completed+cancelled excluded")
    }

    @Test func requestOpenTotalFallsBackToFilteringTheLoadedArrayWhenFieldIsAbsent() throws {
        let json = """
        {
          "container": {"id": "c1", "name": "quantal-health", "status": "active"},
          "agents": [],
          "tasks": [],
          "requests": [
            {"id": "r1", "status": "open"},
            {"id": "r2", "status": "open"},
            {"id": "r3", "status": "answered"},
            {"id": "r4", "status": "closed"}
          ]
        }
        """
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.requestOpenTotal == 2, "2 open requests; answered/closed excluded")
    }

    // MARK: null is treated the same as absent (defensive: a server that ships `null`
    // rather than omitting the key must still fall back cleanly)

    @Test func explicitNullFieldAlsoFallsBackToTheLoadedArray() throws {
        let json = snapshotJSON(
            tasks: #"[{"id":"t1","title":"a","status":"needs_verification"}]"#,
            taskOpenTotal: "null"
        )
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.taskOpenTotal == 1)
    }

    // MARK: terminal-status boundary — every non-terminal status counts, only the two
    // terminal ones are excluded (mirrors MobileUx.isTerminalGroup and the backend's
    // `status NOT IN ('completed', 'cancelled')`)

    @Test(
        "each task status's open-count contribution",
        arguments: [
            ("pending", 1), ("ready", 1), ("in_progress", 1), ("blocked", 1),
            ("needs_verification", 1), ("completed", 0), ("cancelled", 0),
        ]
    )
    func taskStatusOpenContribution(status: String, expectedOpen: Int) throws {
        let json = snapshotJSON(tasks: #"[{"id":"t1","title":"a","status":"\#(status)"}]"#)
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.taskOpenTotal == expectedOpen, "status '\(status)' should contribute \(expectedOpen) to the open total")
    }

    // MARK: this is the exact production shape from the bug report — 62 tasks total,
    // ZERO needs_verification, so any needs_verification-only badge reads "0" next to
    // a header/card reading "62". Reproduced end-to-end as a regression pin.
    @Test func reproducesTheReportedSixtyTwoTasksZeroBadgeShape() throws {
        var rows: [String] = []
        for i in 0..<60 { rows.append(#"{"id":"t\#(i)","title":"x","status":"in_progress"}"#) }
        for i in 60..<62 { rows.append(#"{"id":"t\#(i)","title":"x","status":"completed"}"#) }
        let json = snapshotJSON(tasks: "[\(rows.joined(separator: ","))]")
        let snap = try decoder.decode(ContainerSnapshot.self, from: Data(json.utf8))
        #expect(snap.tasks.count == 62, "the loaded array carries all 62 (matches the header's old tasks.count reading)")
        #expect(snap.taskOpenTotal == 60, "the open total is 60 — NOT 0 (the needs_verification-only misreading this bug fixed)")
    }
}

/// `ContainerHealth` (App/AppModel.swift) — the Containers-home card's "N agents · N open"
/// glance line. `ContainerHealth` itself is a plain populated-elsewhere struct with no
/// logic to unit-test in isolation, so this pins the PRODUCTION SOURCE at its population
/// site: `probeHealth` must read `snap.taskOpenTotal`, not `snap.tasks.count` (the raw
/// capped-array length — the "page length instead of a server total" bug). A source-level
/// pin, same convention as the portal's badge==header-source test.
@Suite struct ContainerHealthCountsTests {
    @Test func probeHealthPopulatesTasksFromTheOpenTotalNotTheRawArrayLength() throws {
        let projectRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // ContainerSnapshotCountsTests.swift
            .deletingLastPathComponent() // OrchaTests
            .appendingPathComponent("Orcha/App/AppModel.swift")
        let src = try String(contentsOf: projectRoot, encoding: .utf8)
        #expect(
            src.contains("tasks: snap.taskOpenTotal"),
            "probeHealth (AppModel.swift) must populate ContainerHealth.tasks from snap.taskOpenTotal (mutation: revert to snap.tasks.count -> RED)"
        )
        #expect(
            !src.contains("tasks: snap.tasks.count"),
            "the raw capped-array length must not be reintroduced at the ContainerHealth population site"
        )
    }
}
