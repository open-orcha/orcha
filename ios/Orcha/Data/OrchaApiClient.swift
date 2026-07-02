import Foundation

/// Thin async URLSession client over the Orcha REST surface — the same endpoints
/// the Android client is proven against. All calls throw on non-2xx.
struct OrchaApiClient {
    private let session: URLSession
    private let decoder = JSONDecoder()

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        session = URLSession(configuration: config)
    }

    // MARK: reads

    func listContainers(_ base: String) async throws -> ContainersResponse {
        try await get(base, "/api/containers")
    }

    func snapshot(_ base: String, _ cid: String) async throws -> ContainerSnapshot {
        try await get(base, "/api/containers/\(cid)")
    }

    func taskMessages(_ base: String, _ tid: String) async throws -> TaskMessagesResponse {
        try await get(base, "/api/tasks/\(tid)/messages")
    }

    func taskRuns(_ base: String, _ tid: String) async throws -> RunsResponse {
        try await get(base, "/api/tasks/\(tid)/runs")
    }

    func agentRuns(_ base: String, _ aid: String) async throws -> RunsResponse {
        try await get(base, "/api/agents/\(aid)/runs")
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

    func conversation(_ base: String, _ aid: String) async throws -> ConversationResponse {
        try await get(base, "/api/agents/\(aid)/conversation")
    }

    func runStreamText(_ base: String, _ aid: String, _ runId: String) async throws -> String {
        let (data, _) = try await raw(base, "/api/agents/\(aid)/runs/\(runId)/stream")
        return String(decoding: data, as: UTF8.self)
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
