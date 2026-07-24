import Foundation

// Responsibility: Orcha API read operations and worker-run stream decoding.

/// One parsed frame of the worker-run SSE stream (`main.py:5671-5673`):
/// `data: {"seq","line"}` progress lines and a terminal `data: {"seq","done","status"}`.
enum RunStreamEvent {
    case line(seq: Int, text: String)
    case done(seq: Int, status: String)
}

/// Thin async URLSession client over the Orcha REST surface — the same endpoints
/// the Android client is proven against. All calls throw on non-2xx.
struct OrchaApiClient {
    let session: URLSession
    /// A separate, un-timed-out session for the run-log SSE stream: a running run never
    /// closes, so the 20s `timeoutIntervalForResource` on `session` would kill it (Issue 3).
    private let streamSession: URLSession
    let decoder = JSONDecoder()

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

}
