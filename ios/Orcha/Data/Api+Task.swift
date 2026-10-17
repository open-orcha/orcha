import Foundation

/// Task-detail parity surface (web portal → Embodent iOS): proof-of-work evidence,
/// Verdikt runs, goal ancestry, the AI manager pre-review, "Make recurring…"
/// routines and reassign. Reads + the human writes the web shows to a person.
extension OrchaApiClient {

    // MARK: reads

    /// `GET /api/tasks/{tid}/evidence` — the evidence pack (DoD lines, tests, risk flags, changes).
    func taskEvidence(_ base: String, _ tid: String) async throws -> EvidencePackDto {
        try await get(base, "/api/tasks/\(tid)/evidence")
    }

    /// `GET /api/tasks/{tid}/verdikt/runs` — Verdikt settings + this task's run history.
    func verdiktRuns(_ base: String, _ tid: String) async throws -> VerdiktRunsResponse {
        try await get(base, "/api/tasks/\(tid)/verdikt/runs")
    }

    /// `GET /api/tasks/{tid}/goal-chain` — objective › parent(s) › this task.
    func goalChain(_ base: String, _ tid: String) async throws -> GoalChainDto {
        try await get(base, "/api/tasks/\(tid)/goal-chain")
    }

    /// The task-list rows for one status (`manager_review` rides these rows, not the
    /// shared `TaskDto`). Used to read the AI manager's pre-review for one task.
    func taskReviewExtras(_ base: String, _ cid: String, status: String) async throws -> [TaskReviewExtrasDto] {
        let response: TaskReviewExtrasPage = try await get(
            base,
            "/api/containers/\(cid)/tasks" + query(["status": status, "limit": "100"])
        )
        return response.tasks
    }

    /// `POST /api/containers/{cid}/routines/preview` — read-only schedule validation.
    func previewTaskRoutineSchedule(_ base: String, _ cid: String, cron: String, timezone: String) async throws -> TaskRoutinePreviewDto {
        try await postDecoding(base, "/api/containers/\(cid)/routines/preview", [
            "cron": cron, "timezone": timezone, "count": 3,
        ])
    }

    // MARK: writes (human actor)

    /// `POST /api/tasks/{tid}/verdikt/runs` — hand this task's definition of done to Verdikt.
    func triggerVerdikt(_ base: String, _ tid: String, actor: String) async throws -> VerdiktRunDto {
        try await postDecoding(base, "/api/tasks/\(tid)/verdikt/runs", ["actor_agent_id": actor])
    }

    /// `POST /api/tasks/{tid}/assign` with `reassign: true` — releases the prior assignee.
    func assignTaskToAgent(_ base: String, _ tid: String, actor: String, agentId: String) async throws -> AssignResultDto {
        try await postDecoding(base, "/api/tasks/\(tid)/assign", [
            "actor_agent_id": actor, "agent_id": agentId, "reassign": true,
        ])
    }

    /// `POST /api/containers/{cid}/routines` — a routine copied from a task (`origin_task_id`).
    func createRoutineFromTask(_ base: String, _ cid: String, actor: String, draft: TaskRoutineDraft) async throws -> TaskRoutineCreatedDto {
        try await postDecoding(base, "/api/containers/\(cid)/routines", [
            "actor_agent_id": actor,
            "title": draft.title,
            "description": draft.description,
            "definition_of_done": draft.definitionOfDone,
            "assignee_agent_id": draft.assigneeAgentId,
            "priority": draft.priority,
            "cron": draft.cron,
            "timezone": draft.timezone,
            "enabled": true,
            "skip_if_open": draft.skipIfOpen,
            "origin_task_id": draft.originTaskId,
        ])
    }
}

private struct TaskReviewExtrasPage: Decodable {
    var tasks: [TaskReviewExtrasDto] = []
}

// MARK: - close implications + deliverables (Task2 slice)

extension OrchaApiClient {

    /// `GET /api/tasks/{tid}/close-implications` — read-only blast radius of closing a task.
    func closeImplications(_ base: String, _ tid: String) async throws -> CloseImplicationsDto {
        try await get(base, "/api/tasks/\(tid)/close-implications")
    }

    /// `GET /api/tasks/{tid}/deliverables` — every deliverable, each with its latest version.
    func taskDeliverables(_ base: String, _ tid: String) async throws -> DeliverableListDto {
        try await get(base, "/api/tasks/\(tid)/deliverables")
    }

    /// `GET /api/tasks/{tid}/deliverables/{did}` — one deliverable with its full history.
    func taskDeliverable(_ base: String, _ tid: String, _ did: String) async throws -> DeliverableDto {
        try await get(base, "/api/tasks/\(tid)/deliverables/\(did)")
    }

    /// `GET …/versions/{v}/text` — UTF-8 preview of a text-kind version.
    func deliverableText(_ base: String, _ tid: String, _ did: String, version: Int) async throws -> DeliverableTextDto {
        try await get(base, "/api/tasks/\(tid)/deliverables/\(did)/versions/\(version)/text")
    }

    /// `GET …/versions/{v}/raw` — the stored bytes (image / PDF preview).
    func deliverableRaw(_ base: String, _ tid: String, _ did: String, version: Int) async throws -> Data {
        try await raw(base, "/api/tasks/\(tid)/deliverables/\(did)/versions/\(version)/raw").0
    }

    /// `GET …/diff?from=&to=` — compare two versions.
    func deliverableDiff(_ base: String, _ tid: String, _ did: String, from: Int, to: Int) async throws -> DeliverableDiffDto {
        try await get(base, "/api/tasks/\(tid)/deliverables/\(did)/diff" + query([
            "from": String(from), "to": String(to),
        ]))
    }

    /// `POST /api/tasks/{tid}/deliverables` (multipart) — a human attaches a file, or a new
    /// version of one with the same name. Attributed to `actor` (`author_agent_id`), as the web does.
    func uploadDeliverable(
        _ base: String, _ tid: String, actor: String, fileName: String, mimeType: String, data: Data
    ) async throws -> DeliverableUploadResultDto {
        guard let url = URL(string: base + "/api/tasks/\(tid)/deliverables") else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        if let token = BearerTokens.token(for: base) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let boundary = "QuorateBoundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = DeliverableMultipart.body(
            boundary: boundary,
            fields: ["author_agent_id": actor],
            fileName: fileName,
            mimeType: mimeType,
            data: data
        )
        let (body, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if Self.perimeterIntercepted(
            status: http.statusCode,
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            body: body
        ) {
            throw OrchaAuthRequiredError()
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: body.prefix(300), as: UTF8.self))
        }
        return try JSONDecoder().decode(DeliverableUploadResultDto.self, from: body)
    }
}

/// Builds a `multipart/form-data` body — pure, so it is unit-tested.
enum DeliverableMultipart {
    static func body(boundary: String, fields: [String: String], fileName: String, mimeType: String, data: Data) -> Data {
        var out = Data()
        func line(_ s: String) { out.append(Data((s + "\r\n").utf8)) }
        for (key, value) in fields.sorted(by: { $0.key < $1.key }) {
            line("--\(boundary)")
            line("Content-Disposition: form-data; name=\"\(key)\"")
            line("")
            line(value)
        }
        let safeName = fileName.replacingOccurrences(of: "\"", with: "_")
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"")
        line("Content-Type: \(mimeType)")
        line("")
        out.append(data)
        line("")
        line("--\(boundary)--")
        return out
    }
}
