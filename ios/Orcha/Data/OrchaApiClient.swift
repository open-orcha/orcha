import Foundation

/// One parsed frame of the worker-run SSE stream (`main.py:5671-5673`):
/// `data: {"seq","line"}` progress lines and a terminal `data: {"seq","done","status"}`.
enum RunStreamEvent {
    case line(seq: Int, text: String)
    case done(seq: Int, status: String)
}

/// Thin async URLSession client over the Orcha REST surface — the same endpoints
/// the Android client is proven against. All calls throw on non-2xx.
struct OrchaApiClient {
    private let session: URLSession
    /// A separate, un-timed-out session for the run-log SSE stream: a running run never
    /// closes, so the 20s `timeoutIntervalForResource` on `session` would kill it (Issue 3).
    private let streamSession: URLSession
    private let decoder = JSONDecoder()

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        session = URLSession(configuration: config)

        let streamConfig = URLSessionConfiguration.ephemeral
        // No caps: 1s heartbeat comments keep the socket live; the server itself caps each
        // open at 30 min (`stream_timeout`), after which the collector reopens.
        streamConfig.timeoutIntervalForRequest = .infinity
        streamConfig.timeoutIntervalForResource = .infinity
        streamSession = URLSession(configuration: streamConfig)
    }

    // MARK: reads

    func listContainers(_ base: String) async throws -> ContainersResponse {
        try await get(base, "/api/containers")
    }

    func snapshot(_ base: String, _ cid: String, taskLimit: Int? = nil, requestLimit: Int? = nil) async throws -> ContainerSnapshot {
        try await get(base, "/api/containers/\(cid)" + query([
            "task_limit": taskLimit.map(String.init),
            "request_limit": requestLimit.map(String.init),
        ]))
    }

    /// Issue 4: with `limit` the endpoint returns the NEWEST `limit` messages (ASC within the
    /// page) plus a `(next_before, next_before_id)` keyset cursor to load earlier pages.
    func taskMessages(_ base: String, _ tid: String, limit: Int? = nil, before: String? = nil, beforeId: String? = nil) async throws -> TaskMessagesResponse {
        try await get(base, "/api/tasks/\(tid)/messages" + query([
            "limit": limit.map(String.init),
            "before": before,
            "before_id": beforeId,
        ]))
    }

    func taskRuns(_ base: String, _ tid: String, limit: Int = 20) async throws -> RunsResponse {
        try await get(base, "/api/tasks/\(tid)/runs" + query(["limit": String(limit)]))
    }

    func agentRuns(_ base: String, _ aid: String, limit: Int = 20) async throws -> RunsResponse {
        try await get(base, "/api/agents/\(aid)/runs" + query(["limit": String(limit)]))
    }

    func residentRuns(_ base: String, _ aid: String) async throws -> RunsResponse {
        try await get(base, "/api/agents/\(aid)/resident-runs")
    }

    func persona(_ base: String, _ aid: String) async throws -> PersonaResponse {
        try await get(base, "/api/agents/\(aid)/persona")
    }

    func digest(_ base: String, _ aid: String) async throws -> DigestResponse {
        try await get(base, "/api/agents/\(aid)/digest")
    }

    func inbox(_ base: String, _ aid: String) async throws -> InboxResponse {
        try await get(base, "/api/agents/\(aid)/inbox")
    }

    func outbox(_ base: String, _ aid: String) async throws -> OutboxResponse {
        try await get(base, "/api/agents/\(aid)/outbox")
    }

    func models(_ base: String) async throws -> ModelsResponse {
        try await get(base, "/api/models")
    }

    func conversation(_ base: String, _ aid: String, limit: Int? = nil) async throws -> ConversationResponse {
        try await get(base, "/api/agents/\(aid)/conversation" + query(["limit": limit.map(String.init)]))
    }

    /// Issue 4: delta-append the turns created after `afterSeq` (oldest→newest), instead of
    /// full-replacing the whole conversation on every refresh.
    func conversationTurns(_ base: String, _ convId: String, afterSeq: Int, limit: Int = 50) async throws -> TurnsResponse {
        try await get(base, "/api/conversations/\(convId)/turns" + query([
            "after_seq": String(afterSeq), "limit": String(limit),
        ]))
    }

    /// One-shot read of a FINISHED run's log (the server closes the stream immediately, so a
    /// buffered read completes). RUNNING runs must use `runStream` instead — see Issue 3.
    func runStreamText(_ base: String, _ aid: String, _ runId: String) async throws -> String {
        let (data, _) = try await raw(base, "/api/agents/\(aid)/runs/\(runId)/stream")
        return String(decoding: data, as: UTF8.self)
    }

    /// Issue 3: incremental SSE reader for a RUNNING run's log. Yields one event per parsed
    /// `data:` frame; heartbeat comment lines (`:`) and blanks are skipped. The stream ends on
    /// the terminal `done` frame, an error, or cancellation (which cancels the URLSession task).
    func runStream(_ base: String, _ aid: String, _ runId: String) -> AsyncThrowingStream<RunStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let work = Task {
                do {
                    var request = URLRequest(url: try url(base, "/api/agents/\(aid)/runs/\(runId)/stream"))
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await streamSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                    guard (200..<300).contains(http.statusCode) else {
                        throw OrchaApiError(status: http.statusCode, body: "")
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if let event = Self.parseSseEvent(line) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    /// Parse a single SSE line into an event. Only `data:`-prefixed JSON frames yield an event.
    static func parseSseEvent(_ line: String) -> RunStreamEvent? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard
            let data = payload.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let seq = (obj["seq"] as? Int) ?? (obj["seq"] as? NSNumber)?.intValue ?? -1
        if (obj["done"] as? Bool) == true {
            return .done(seq: seq, status: (obj["status"] as? String) ?? "finished")
        }
        if let text = obj["line"] as? String { return .line(seq: seq, text: text) }
        return nil
    }

    // MARK: writes (actor ids per the human-authority contract)

    func postTaskMessage(_ base: String, _ tid: String, actor: String, body: String) async throws {
        try await post(base, "/api/tasks/\(tid)/messages", ["author_agent_id": actor, "body": body])
    }

    func cancelTask(_ base: String, _ tid: String, actor: String, reason: String?) async throws {
        try await post(base, "/api/tasks/\(tid)/cancel", ["actor_agent_id": actor, "reason": reason])
    }

    func verifyTask(_ base: String, _ tid: String, actor: String, approve: Bool, feedback: String?) async throws {
        try await post(base, "/api/tasks/\(tid)/verify", ["approve": approve, "feedback": feedback, "actor_agent_id": actor])
    }

    func decidePlan(_ base: String, _ tid: String, actor: String, approve: Bool, reason: String?, target: String?) async throws {
        try await post(base, "/api/decisions", [
            "subject_type": "plan_approval",
            "subject_id": tid,
            "decision": approve ? "approve" : "reject",
            "reason": reason,
            "actor_agent_id": actor,
            "target_agent_id": target,
        ])
    }

    func respondRequest(_ base: String, _ rid: String, actor: String, response: String) async throws {
        try await post(base, "/api/requests/\(rid)/respond", ["responder_agent_id": actor, "response": response])
    }

    func closeRequest(_ base: String, _ rid: String, actor: String, reason: String?) async throws {
        try await post(base, "/api/requests/\(rid)/close", ["requester_agent_id": actor, "reason": reason])
    }

    func nudgeRequest(_ base: String, _ rid: String, actor: String, note: String?) async throws {
        try await post(base, "/api/requests/\(rid)/nudge", ["actor_agent_id": actor, "note": note])
    }

    func escalateRequest(_ base: String, _ rid: String, actor: String, reason: String?) async throws {
        try await post(base, "/api/requests/\(rid)/escalate", ["requester_agent_id": actor, "reason": reason])
    }

    func acceptTaskRequest(_ base: String, _ rid: String, actor: String, note: String?) async throws {
        try await post(base, "/api/requests/\(rid)/accept-task", ["responder_agent_id": actor, "note": note])
    }

    func rejectTaskRequest(_ base: String, _ rid: String, actor: String, reason: String) async throws {
        try await post(base, "/api/requests/\(rid)/reject-task", ["responder_agent_id": actor, "reason": reason])
    }

    func convertRequest(_ base: String, _ rid: String, actor: String, title: String, dod: String, assignee: String?) async throws {
        try await post(base, "/api/requests/\(rid)/convert-to-task", [
            "requester_agent_id": actor,
            "title": title,
            "definition_of_done": dod,
            "assignee_alias": assignee,
        ])
    }

    func triageCloseRequest(_ base: String, _ rid: String) async throws {
        try await post(base, "/api/requests/\(rid)/triage-close", [:])
    }

    func updateAgentModel(_ base: String, _ aid: String, model: String) async throws {
        try await post(base, "/api/agents/\(aid)/model", ["model": model])
    }

    func updateAutoWake(_ base: String, _ aid: String, actor: String, intervalSecs: Int?) async throws {
        try await patch(base, "/api/agents/\(aid)/auto-wake", ["actor_agent_id": actor, "interval_secs": intervalSecs])
    }

    func renameAgent(_ base: String, _ aid: String, actor: String, alias: String) async throws {
        try await patch(base, "/api/agents/\(aid)", ["actor_agent_id": actor, "alias": alias])
    }

    func retireAgent(_ base: String, _ aid: String, actor: String) async throws {
        try await post(base, "/api/agents/\(aid)/retire", ["actor_agent_id": actor])
    }

    func startConversation(_ base: String, _ aid: String, actor: String) async throws -> ConversationResponse {
        try await postDecoding(base, "/api/agents/\(aid)/conversations", ["actor_agent_id": actor])
    }

    func sendTurn(_ base: String, _ conversationId: String, actor: String, content: String) async throws {
        try await post(base, "/api/conversations/\(conversationId)/turns", [
            "role": "human", "author_agent_id": actor, "content": content,
        ])
    }

    func endConversation(_ base: String, _ conversationId: String, actor: String) async throws {
        try await post(base, "/api/conversations/\(conversationId)/end", ["actor_agent_id": actor])
    }

    func stopRun(_ base: String, _ runId: String, actor: String) async throws {
        try await post(base, "/api/runs/\(runId)/stop", ["actor_agent_id": actor])
    }

    func createTask(
        _ base: String, _ cid: String, actor: String,
        title: String, description: String?, dod: String,
        assignee: String?, priority: Int, dependsOn: [String], notReady: Bool
    ) async throws -> GenericIdResponse {
        try await postDecoding(base, "/api/containers/\(cid)/tasks", [
            "title": title,
            "description": description,
            "definition_of_done": dod,
            "priority": priority,
            "created_by_agent_id": actor,
            "assignee_alias": assignee,
            "depends_on": dependsOn,
            "not_ready": notReady,
        ])
    }

    // MARK: plumbing

    private func url(_ base: String, _ path: String) throws -> URL {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        return url
    }

    /// Build a `?a=1&b=2` suffix, dropping nil values and percent-encoding each value
    /// (ISO cursors carry `:`/`+` — over-encode to a conservative unreserved set).
    private func query(_ items: [String: String?]) -> String {
        let pairs = items
            .sorted { $0.key < $1.key }
            .compactMap { key, value -> String? in
                guard let value else { return nil }
                let encoded = value.addingPercentEncoding(withAllowedCharacters: .orchaQueryValue) ?? value
                return "\(key)=\(encoded)"
            }
        return pairs.isEmpty ? "" : "?" + pairs.joined(separator: "&")
    }

    private func raw(_ base: String, _ path: String) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(from: url(base, path))
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return (data, http)
    }

    private func get<T: Decodable>(_ base: String, _ path: String) async throws -> T {
        let (data, _) = try await raw(base, path)
        return try decoder.decode(T.self, from: data)
    }

    private func send(_ base: String, _ path: String, method: String, _ body: [String: Any?]) async throws -> Data {
        var request = URLRequest(url: try url(base, path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let cleaned = body.compactMapValues { $0 }
        request.httpBody = try JSONSerialization.data(withJSONObject: cleaned)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return data
    }

    private func post(_ base: String, _ path: String, _ body: [String: Any?]) async throws {
        _ = try await send(base, path, method: "POST", body)
    }

    private func postDecoding<T: Decodable>(_ base: String, _ path: String, _ body: [String: Any?]) async throws -> T {
        let data = try await send(base, path, method: "POST", body)
        return try decoder.decode(T.self, from: data)
    }

    private func patch(_ base: String, _ path: String, _ body: [String: Any?]) async throws {
        _ = try await send(base, path, method: "PATCH", body)
    }
}

private extension CharacterSet {
    /// Conservative unreserved set for query VALUES — encodes `:`, `+`, `&`, `=`, space, etc.
    static let orchaQueryValue = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}

struct OrchaApiError: LocalizedError {
    let status: Int
    let body: String

    var errorDescription: String? {
        switch status {
        case 403: "This action is not allowed for the paired human."
        case 409: "Orcha rejected this action because the item changed. Refresh and try again."
        case 422: "Orcha needs more information for this action."
        default: "Orcha answered with an error (\(status))."
        }
    }
}
