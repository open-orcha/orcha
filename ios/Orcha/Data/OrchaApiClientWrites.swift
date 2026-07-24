import Foundation

// Responsibility: Orcha API mutation operations for human-authorized mobile actions.

extension OrchaApiClient {
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

    /// GH #148 — the notifier (kill-switch). Human-only on the server; `actor` is the
    /// paired human, not an agent id.
    func setWakes(_ base: String, _ cid: String, actor: String, enabled: Bool) async throws {
        try await post(base, "/api/containers/\(cid)/wakes", ["enabled": enabled, "actor_agent_id": actor])
    }

    /// GH #148 — the autonomy gearbox (`plan` | `pr` | `full`). Human-gated on the server.
    func setAutonomy(_ base: String, _ cid: String, actor: String, level: String) async throws {
        try await post(base, "/api/containers/\(cid)/autonomy", ["level": level, "actor_agent_id": actor])
    }

    /// Flow 07a: returns the routed outcome so the UI can tell a real wake
    /// (`nudged:true` → "Nudged {alias}") from the human-owns-it no-op (`nudged:false`).
    func nudgeRequest(_ base: String, _ rid: String, actor: String, note: String?) async throws -> NudgeResult {
        try await postDecoding(base, "/api/requests/\(rid)/nudge", ["actor_agent_id": actor, "note": note])
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

}
