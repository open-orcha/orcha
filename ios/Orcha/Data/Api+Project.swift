import Foundation

/// Project slice endpoints: objective, agent limit, project budget, performance metrics,
/// agent worktrees and routine create / edit. Writes carry `actor_agent_id` (the paired
/// human); under the trusted proxy the server uses the verified identity instead.
extension OrchaApiClient {

    // MARK: objective

    /// `PUT /api/containers/{cid}/objective` — an empty objective clears it (JSON null).
    func putObjective(_ base: String, _ cid: String, actor: String?, objective: String?) async throws -> ContainerObjectiveDto {
        try await putDecoding(base, "/api/containers/\(cid)/objective", [
            "objective": objective.map { $0 as Any } ?? NSNull(),
            "actor_agent_id": actor,
        ])
    }

    // MARK: agent limit

    func containerLimits(_ base: String, _ cid: String) async throws -> ContainerLimitsDto {
        try await get(base, "/api/containers/\(cid)/limits")
    }

    func putContainerLimits(_ base: String, _ cid: String, actor: String, maxAutoAgents: Int) async throws -> ContainerLimitsDto {
        try await putDecoding(base, "/api/containers/\(cid)/limits", [
            "max_auto_agents": maxAutoAgents, "actor_agent_id": actor,
        ])
    }

    // MARK: project budget

    func projectBudgets(_ base: String, _ cid: String) async throws -> ProjectBudgetsDto {
        try await get(base, "/api/containers/\(cid)/budgets")
    }

    /// `PUT /api/containers/{cid}/budget` — same partial-update body as an agent budget.
    func putProjectBudget(_ base: String, _ cid: String, actor: String, body: AgentBudgetUpdate) async throws -> AgentBudgetDto {
        try await putDecoding(base, "/api/containers/\(cid)/budget", body.json(actor: actor))
    }

    // MARK: metrics

    func performance(_ base: String, _ cid: String, range: String) async throws -> PerformanceDto {
        try await get(base, "/api/containers/\(cid)/metrics/performance" + query(["range": range]))
    }

    func agentPerformance(_ base: String, _ cid: String, agentId: String, range: String) async throws -> AgentPerformanceDto {
        try await get(base, "/api/containers/\(cid)/metrics/performance/agents/\(agentId)" + query(["range": range]))
    }

    // MARK: agent worktrees

    func agentWorktrees(_ base: String, _ cid: String) async throws -> AgentWorktreesDto {
        try await get(base, "/api/containers/\(cid)/agent-worktrees")
    }

    /// `PUT …/agent-worktrees/settings` — nil leaves a field unchanged.
    func putWorktreeSettings(_ base: String, _ cid: String, actor: String?, autoCleanup: Bool?, graceDays: Int?) async throws -> WorktreeSettingsDto {
        try await putDecoding(base, "/api/containers/\(cid)/agent-worktrees/settings", [
            "auto_cleanup": autoCleanup, "grace_days": graceDays, "actor_agent_id": actor,
        ])
    }

    /// Files a "clean up the clean worktrees" request; the notifier carries it out on the host.
    func requestWorktreeCleanup(_ base: String, _ cid: String, actor: String?) async throws -> WorktreeActionDto {
        try await postDecoding(base, "/api/containers/\(cid)/agent-worktrees/actions", [
            "action": "clean_up", "include_output": false, "unmerged_paths": [String](), "actor_agent_id": actor,
        ])
    }

    func worktreeAction(_ base: String, _ cid: String, actionId: String) async throws -> WorktreeActionDto {
        try await get(base, "/api/containers/\(cid)/agent-worktrees/actions/\(actionId)")
    }

    // MARK: routines (create / edit)

    func routine(_ base: String, _ rid: String) async throws -> RoutineReadDto {
        try await get(base, "/api/routines/\(rid)")
    }

    func createRoutine(_ base: String, _ cid: String, actor: String?, input: RoutineInput) async throws -> RoutineReadDto {
        try await projectSend(base, "/api/containers/\(cid)/routines", method: "POST", body: input.json(actor: actor))
    }

    func updateRoutine(_ base: String, _ rid: String, actor: String?, input: RoutineInput) async throws -> RoutineReadDto {
        try await projectSend(base, "/api/routines/\(rid)", method: "PATCH", body: input.json(actor: actor))
    }

    func previewRoutineSchedule(_ base: String, _ cid: String, cron: String, timezone: String) async throws -> TaskRoutinePreviewDto {
        try await postDecoding(base, "/api/containers/\(cid)/routines/preview", [
            "cron": cron, "timezone": timezone, "count": 3,
        ])
    }

    // MARK: plumbing

    /// A twin of the client's private `send` that keeps explicit JSON nulls (PATCH clears)
    /// — same bearer + perimeter rules, so this slice never edits the shared client file.
    private func projectSend<T: Decodable>(_ base: String, _ path: String, method: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        if let token = BearerTokens.token(for: base) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if Self.perimeterIntercepted(
            status: http.statusCode,
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            body: data
        ) {
            throw OrchaAuthRequiredError()
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OrchaApiError(status: http.statusCode, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
