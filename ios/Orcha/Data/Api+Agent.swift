import Foundation

/// Agent slice endpoints: budgets, reporting lines, live run changes and config history.
/// Writes carry `actor_agent_id` (the paired human) per the human-authority contract.
extension OrchaApiClient {

    // MARK: budgets

    func agentBudget(_ base: String, _ aid: String) async throws -> AgentBudgetDto {
        try await get(base, "/api/agents/\(aid)/budget")
    }

    func containerBudgets(_ base: String, _ cid: String) async throws -> ContainerBudgetsDto {
        try await get(base, "/api/containers/\(cid)/budgets")
    }

    /// `PUT /api/agents/{aid}/budget`. A key left out is unchanged; `.clear` sends an
    /// explicit JSON null (the server clears that limit).
    func updateAgentBudget(_ base: String, _ aid: String, actor: String, body: AgentBudgetUpdate) async throws -> AgentBudgetDto {
        try await putDecoding(base, "/api/agents/\(aid)/budget", body.json(actor: actor))
    }

    // MARK: reporting lines

    func reportsTo(_ base: String, _ aid: String) async throws -> ReportsToDto {
        try await get(base, "/api/agents/\(aid)/reports-to")
    }

    /// `PUT /api/agents/{aid}/reports-to` — set the manager, or clear it with `nil`
    /// (sent as an explicit JSON null: the field is required). Owner / manage_agents only;
    /// 422 = not a live agent in this project, 409 = it would make a loop.
    func setReportsTo(_ base: String, _ aid: String, managerId: String?, actor: String) async throws -> ReportsToDto {
        try await putDecoding(base, "/api/agents/\(aid)/reports-to", [
            "reports_to_agent_id": managerId.map { $0 as Any } ?? NSNull(),
            "actor_agent_id": actor,
        ])
    }

    /// The reporting line of every agent in one read (a projection of the snapshot).
    func orgLines(_ base: String, _ cid: String) async throws -> OrgSnapshotDto {
        try await get(base, "/api/containers/\(cid)" + query(["task_limit": "1", "request_limit": "1"]))
    }

    // MARK: live run changes

    func runChanges(_ base: String, _ aid: String, _ rid: String, since: String?) async throws -> RunChangesDto {
        try await get(base, "/api/agents/\(aid)/runs/\(rid)/changes" + query(["since": since]))
    }

    func runChangeDiff(_ base: String, _ aid: String, _ rid: String, path: String) async throws -> RunDiffDto {
        try await get(base, "/api/agents/\(aid)/runs/\(rid)/changes/diff" + query(["path": path]))
    }

    /// Raw bytes of one side (`old` | `new`) of a changed file — image previews.
    func runChangeRaw(_ base: String, _ aid: String, _ rid: String, path: String, side: String = "new") async throws -> Data {
        try await raw(base, "/api/agents/\(aid)/runs/\(rid)/changes/raw" + query(["path": path, "side": side])).0
    }

    // MARK: config history

    func configRevisions(_ base: String, _ aid: String, before: Int? = nil, limit: Int = 30) async throws -> ConfigRevisionPageDto {
        try await get(base, "/api/agents/\(aid)/config-revisions" + query([
            "before": before.map(String.init), "limit": String(limit),
        ]))
    }

    func configRevision(_ base: String, _ aid: String, _ rev: Int) async throws -> ConfigRevisionDetailDto {
        try await get(base, "/api/agents/\(aid)/config-revisions/\(rev)")
    }

    func restoreConfigRevision(_ base: String, _ aid: String, _ rev: Int, actor: String, reason: String?) async throws -> ConfigRestoreResultDto {
        try await postDecoding(base, "/api/agents/\(aid)/config-revisions/\(rev)/restore", [
            "actor_agent_id": actor, "reason": reason,
        ])
    }
}

/// A partial budget update: `nil` = leave unchanged.
struct AgentBudgetUpdate: Equatable {
    enum Limit<T: Equatable>: Equatable { case set(T), clear }

    var usd: Limit<Double>?
    var tokens: Limit<Int>?
    /// `grant` | `revoke`
    var override: String?
    var note: String?

    func json(actor: String) -> [String: Any?] {
        var body: [String: Any?] = ["actor_agent_id": actor]
        switch usd {
        case let .set(v): body["monthly_limit_usd"] = v
        case .clear: body["monthly_limit_usd"] = NSNull()
        case nil: break
        }
        switch tokens {
        case let .set(v): body["monthly_limit_tokens"] = v
        case .clear: body["monthly_limit_tokens"] = NSNull()
        case nil: break
        }
        if let override { body["override"] = override }
        if let note, !note.isEmpty { body["note"] = note }
        return body
    }
}
