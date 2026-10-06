import Foundation
import Testing
@testable import Orcha

/// Task2 slice: close-implications + deliverables DTO decoding and pure copy logic.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct CloseImplicationsTests {

    @Test func decodesTheServerSummaryObject() throws {
        let r = try decode(CloseImplicationsDto.self, """
        {"task_id":"t1","title":"x","status":"in_progress","is_root":false,
         "upstream_tasks":[],"downstream_tasks":[{"task_id":"d1"}],"in_flight_agents":[],
         "summary":{"upstream_total":0,"blocked_by":0,"downstream_total":3,"would_unblock":2,
                    "still_blocked":1,"in_flight_agents":1,"open_requests":2,"completes_container":false}}
        """)
        let s = try #require(r.summary)
        #expect(s.downstreamTotal == 3)
        #expect(s.wouldUnblock == 2)
        #expect(s.inFlightAgents == 1)
        #expect(s.openRequests == 2)
    }

    @Test func linesMatchAndroidWording() {
        let r = CloseImplicationsDto(summary: .init(
            downstreamTotal: 3, wouldUnblock: 2, stillBlocked: 1, inFlightAgents: 1, openRequests: 1
        ))
        #expect(CloseImplicationsUx.lines(r) == [
            "3 downstream tasks depend on it: 2 would unblock, 1 stay blocked.",
            "1 agent is working on it right now.",
            "1 open request from its assignees would be orphaned.",
        ])
    }

    @Test func pluralAgentsAndRootLine() {
        let r = CloseImplicationsDto(summary: .init(inFlightAgents: 2, completesContainer: true))
        #expect(CloseImplicationsUx.lines(r) == [
            "This is the root task — closing it marks the whole project complete.",
            "2 agents are working on it right now.",
        ])
    }

    @Test func nothingToWarnFallsBackToGenericCopy() {
        #expect(CloseImplicationsUx.message(nil) == CloseImplicationsUx.genericCopy)
        #expect(CloseImplicationsUx.message(CloseImplicationsDto(summary: .init())) == CloseImplicationsUx.genericCopy)
    }

    @Test func messageBulletsEachLine() {
        let r = CloseImplicationsDto(summary: nil, implications: ["A", " ", "B"])
        #expect(CloseImplicationsUx.message(r) == "· A\n· B")
    }
}

@Suite struct DeliverablesDecodingTests {

    @Test func listDecodesTheWebShape() throws {
        let list = try decode(DeliverableListDto.self, """
        {"task_id":"t1","deliverables":[{"id":"d1","task_id":"t1","path":"reports/q3.md","name":"q3.md",
          "kind":"markdown","latest_version":2,"version_count":2,"created_at":"2026-10-01T10:00:00Z",
          "updated_at":"2026-10-01T11:00:00Z",
          "latest":{"version":2,"source":"run_output","run_id":"r1","author_agent_id":"a1",
                    "author_alias":"forge","author_kind":"ai","size_bytes":2048,"sha256":"abc",
                    "content_type":"text/markdown","note":null,"created_at":"2026-10-01T11:00:00Z",
                    "raw_url":"/x/raw","text_url":"/x/text"}}],
         "limits":{"max_bytes":26214400,"max_deliverables_per_task":50,"max_versions_per_deliverable":50,
                   "allowed_extensions":["md","png"],"outputs_folder":".orcha/outputs"}}
        """)
        let d = try #require(list.deliverables.first)
        #expect(d.name == "q3.md")
        #expect(d.kind == "markdown")
        #expect(d.versionCount == 2)
        #expect(d.latest?.authorAlias == "forge")
        #expect(d.latest?.sizeBytes == 2048)
        #expect(list.limits?.allowedExtensions == ["md", "png"])
        #expect(list.limits?.outputsFolder == ".orcha/outputs")
    }

    @Test func detailCarriesVersions() throws {
        let d = try decode(DeliverableDto.self, """
        {"id":"d1","path":"chart.png","kind":"image","latest_version":2,"version_count":2,
         "versions":[{"version":2,"source":"attached","size_bytes":10},{"version":1,"source":"attached","size_bytes":9}]}
        """)
        #expect(d.versions?.map(\.version) == [2, 1])
        #expect(d.name == "chart.png")
    }

    @Test func textAndDiffDecode() throws {
        let t = try decode(DeliverableTextDto.self, ##"{"text":"# Hi","truncated":true,"kind":"markdown"}"##)
        #expect(t.text == "# Hi")
        #expect(t.truncated)
        let diff = try decode(DeliverableDiffDto.self, """
        {"binary":false,"bytes_changed":true,"diff":"diff --git a/x b/x","added":1,"removed":0,"identical":false,"truncated":false}
        """)
        #expect(diff.bytesChanged)
        #expect(diff.added == 1)
        let bin = try decode(DeliverableDiffDto.self, #"{"binary":true,"bytes_changed":false}"#)
        #expect(bin.binary)
        #expect(bin.diff == nil)
    }

    @Test func uploadResultDecodesDedup() throws {
        #expect(try decode(DeliverableUploadResultDto.self, #"{"deduplicated":true}"#).deduplicated)
        #expect(try decode(DeliverableUploadResultDto.self, #"{"deduplicated":false,"version":{}}"#).deduplicated == false)
    }
}

@Suite struct DeliverableUxTests {

    @Test(arguments: [
        (nil as Int?, "—"), (512, "512 B"), (2048, "2.0 KB"), (20_480, "20 KB"), (3 * 1024 * 1024, "3.0 MB"),
    ])
    func formatBytes(_ n: Int?, _ expected: String) {
        #expect(DeliverableUx.formatBytes(n) == expected)
    }

    @Test func dirOfMatchesWeb() {
        #expect(DeliverableUx.dirOf("reports/q3.md") == "reports/")
        #expect(DeliverableUx.dirOf("q3.md") == "")
    }

    @Test func sourceLabelMatchesWeb() {
        #expect(DeliverableUx.sourceLabel(.init(version: 1, source: "run_output", authorAlias: "forge")) == "Run output · forge")
        #expect(DeliverableUx.sourceLabel(.init(version: 1, source: "run_output")) == "Run output · agent run")
        #expect(DeliverableUx.sourceLabel(.init(version: 1, source: "attached")) == "Attached")
        #expect(DeliverableUx.sourceLabel(nil) == "")
    }

    @Test func attachOnlyOnOpenNonRootTasksWithWrite() {
        #expect(DeliverableUx.canAttach(status: "in_progress", isRoot: false, canWrite: true))
        #expect(!DeliverableUx.canAttach(status: "completed", isRoot: false, canWrite: true))
        #expect(!DeliverableUx.canAttach(status: "in_progress", isRoot: true, canWrite: true))
        #expect(!DeliverableUx.canAttach(status: "in_progress", isRoot: false, canWrite: false))
    }

    @Test func uploadToastCopy() {
        #expect(DeliverableUx.uploadToast(added: 1, unchanged: 0) == "Attached 1 file")
        #expect(DeliverableUx.uploadToast(added: 2, unchanged: 1) == "Attached 2 files · 1 unchanged")
        #expect(DeliverableUx.uploadToast(added: 0, unchanged: 1) == "No changes — identical to the latest version")
    }

    @Test func serverDetailAndMime() {
        #expect(DeliverableUx.serverDetail(#"{"detail":"file too large (max 25 MiB)"}"#) == "file too large (max 25 MiB)")
        #expect(DeliverableUx.serverDetail("oops") == nil)
        #expect(DeliverableUx.mimeType(for: "a.JPG") == "image/jpeg")
        #expect(DeliverableUx.mimeType(for: "a.md") == "text/markdown")
    }

    @Test func multipartBodyCarriesFieldsAndFile() {
        let body = DeliverableMultipart.body(
            boundary: "B", fields: ["author_agent_id": "h1"],
            fileName: "a.txt", mimeType: "text/plain", data: Data("hi".utf8)
        )
        let s = String(decoding: body, as: UTF8.self)
        #expect(s == "--B\r\nContent-Disposition: form-data; name=\"author_agent_id\"\r\n\r\nh1\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n")
    }
}
