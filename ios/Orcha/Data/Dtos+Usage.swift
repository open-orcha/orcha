import Foundation

// Usage slice DTOs — the Metrics aggregate (`container_metrics_routes.py`), the token
// meter (`container_token_usage_routes.py`), one agent's spend drilldown and the
// rule-based insights (`agent_spend_routes.py`). Every field is lenient: a missing or
// null number reads as 0 / nil so an older or newer server never breaks decoding.

private extension KeyedDecodingContainer {
    func int(_ key: Key) -> Int {
        if let v = try? decodeIfPresent(Int.self, forKey: key) { return v }
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return Int(d) }
        return 0
    }

    func double(_ key: Key) -> Double { (try? decodeIfPresent(Double.self, forKey: key)) ?? 0 }
    func optInt(_ key: Key) -> Int? { (try? decodeIfPresent(Int.self, forKey: key)) ?? nil }
    func optDouble(_ key: Key) -> Double? { (try? decodeIfPresent(Double.self, forKey: key)) ?? nil }
    func string(_ key: Key) -> String? { (try? decodeIfPresent(String.self, forKey: key)) ?? nil }
}

// MARK: - Metrics aggregate  (GET /api/containers/{cid}/metrics?days=7|30)

struct MetricsTotalsDto: Decodable, Equatable {
    var runs = 0
    var sandboxSeconds = 0.0
    var estCostUsd = 0.0
    var tokensIn = 0
    var tokensOut = 0
    var runsWithCost = 0
    var runsWithTokens: Int?
    var tasksCompleted = 0
    var tasksVerified = 0

    enum CodingKeys: String, CodingKey {
        case runs
        case sandboxSeconds = "sandbox_seconds"
        case estCostUsd = "est_cost_usd"
        case tokensIn = "tokens_in"
        case tokensOut = "tokens_out"
        case runsWithCost = "runs_with_cost"
        case runsWithTokens = "runs_with_tokens"
        case tasksCompleted = "tasks_completed"
        case tasksVerified = "tasks_verified"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runs = c.int(.runs)
        sandboxSeconds = c.double(.sandboxSeconds)
        estCostUsd = c.double(.estCostUsd)
        tokensIn = c.int(.tokensIn)
        tokensOut = c.int(.tokensOut)
        runsWithCost = c.int(.runsWithCost)
        runsWithTokens = c.optInt(.runsWithTokens)
        tasksCompleted = c.int(.tasksCompleted)
        tasksVerified = c.int(.tasksVerified)
    }
}

struct MetricsAgentDto: Decodable, Equatable, Identifiable, Hashable {
    var agentId: String
    var alias: String?
    var model: String?
    var runs = 0
    var okRuns = 0
    var failedRuns = 0
    var sandboxSeconds = 0.0
    var estCostUsd = 0.0
    var tokensIn = 0
    var tokensOut = 0
    var runsWithTokens: Int?
    var lastActive: String?

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case alias, model, runs
        case agentId = "agent_id"
        case okRuns = "ok_runs"
        case failedRuns = "failed_runs"
        case sandboxSeconds = "sandbox_seconds"
        case estCostUsd = "est_cost_usd"
        case tokensIn = "tokens_in"
        case tokensOut = "tokens_out"
        case runsWithTokens = "runs_with_tokens"
        case lastActive = "last_active"
    }

    init(agentId: String, alias: String?, runs: Int = 0, okRuns: Int = 0, failedRuns: Int = 0) {
        self.agentId = agentId
        self.alias = alias
        self.runs = runs
        self.okRuns = okRuns
        self.failedRuns = failedRuns
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decode(String.self, forKey: .agentId)
        alias = c.string(.alias)
        model = c.string(.model)
        runs = c.int(.runs)
        okRuns = c.int(.okRuns)
        failedRuns = c.int(.failedRuns)
        sandboxSeconds = c.double(.sandboxSeconds)
        estCostUsd = c.double(.estCostUsd)
        tokensIn = c.int(.tokensIn)
        tokensOut = c.int(.tokensOut)
        runsWithTokens = c.optInt(.runsWithTokens)
        lastActive = c.string(.lastActive)
    }
}

struct MetricsDayDto: Decodable, Equatable, Identifiable {
    var date: String
    var runs = 0
    var estCostUsd = 0.0

    var id: String { date }

    enum CodingKeys: String, CodingKey {
        case date, runs
        case estCostUsd = "est_cost_usd"
    }

    init(date: String, runs: Int, estCostUsd: Double = 0) {
        self.date = date
        self.runs = runs
        self.estCostUsd = estCostUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = c.string(.date) ?? ""
        runs = c.int(.runs)
        estCostUsd = c.double(.estCostUsd)
    }
}

struct MetricsSummaryDto: Decodable, Equatable {
    var days = 7
    var totals = MetricsTotalsDto()
    var perAgent: [MetricsAgentDto] = []
    var daily: [MetricsDayDto] = []

    enum CodingKeys: String, CodingKey {
        case days, totals, daily
        case perAgent = "per_agent"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        days = c.optInt(.days) ?? 7
        totals = (try? c.decodeIfPresent(MetricsTotalsDto.self, forKey: .totals)) ?? MetricsTotalsDto()
        perAgent = (try? c.decodeIfPresent([MetricsAgentDto].self, forKey: .perAgent)) ?? []
        daily = (try? c.decodeIfPresent([MetricsDayDto].self, forKey: .daily)) ?? []
    }
}

// MARK: - Token meter  (GET /api/containers/{cid}/token-usage)

/// The four token kinds plus their sum, the dollar figure and the run count. Shared by
/// the meter windows and the spend drilldown's totals / task rows.
struct TokenMixDto: Decodable, Equatable {
    var inputTokens = 0
    var outputTokens = 0
    var cacheReadTokens = 0
    var cacheWriteTokens = 0
    var totalTokens = 0
    var totalCostUsd = 0.0
    var runs = 0
    /// Spend rows only: runs that recorded a dollar cost (nil on an older server).
    var runsWithCost: Int?
    /// Meter windows only: the pinned plan quota (nil = not configured).
    var quotaTokens: Int?
    var pctOfQuota: Double?

    enum CodingKeys: String, CodingKey {
        case runs
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case cacheReadTokens = "cache_read_input_tokens"
        case cacheWriteTokens = "cache_creation_input_tokens"
        case totalTokens = "total_tokens"
        case totalCostUsd = "total_cost_usd"
        case runsWithCost = "runs_with_cost"
        case quotaTokens = "quota_tokens"
        case pctOfQuota = "pct_of_quota"
    }

    init() {}

    init(input: Int, output: Int, cacheRead: Int, cacheWrite: Int, cost: Double = 0, runs: Int = 0) {
        inputTokens = input
        outputTokens = output
        cacheReadTokens = cacheRead
        cacheWriteTokens = cacheWrite
        totalTokens = input + output + cacheRead + cacheWrite
        totalCostUsd = cost
        self.runs = runs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = c.int(.inputTokens)
        outputTokens = c.int(.outputTokens)
        cacheReadTokens = c.int(.cacheReadTokens)
        cacheWriteTokens = c.int(.cacheWriteTokens)
        totalTokens = c.optInt(.totalTokens) ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)
        totalCostUsd = c.double(.totalCostUsd)
        runs = c.int(.runs)
        runsWithCost = c.optInt(.runsWithCost)
        quotaTokens = c.optInt(.quotaTokens)
        pctOfQuota = c.optDouble(.pctOfQuota)
    }
}

struct TokenUsageAgentDto: Decodable, Equatable, Identifiable {
    var agentId: String
    var alias: String?
    var runs = 0
    var totalTokens = 0
    var totalCostUsd = 0.0

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case alias, runs
        case agentId = "agent_id"
        case totalTokens = "total_tokens"
        case totalCostUsd = "total_cost_usd"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decode(String.self, forKey: .agentId)
        alias = c.string(.alias)
        runs = c.int(.runs)
        totalTokens = c.int(.totalTokens)
        totalCostUsd = c.double(.totalCostUsd)
    }
}

struct LastWakeDto: Decodable, Equatable {
    var runId: String?
    var agentAlias: String?
    var endedAt: String?
    var totalTokens = 0
    var totalCostUsd = 0.0

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case agentAlias = "agent_alias"
        case endedAt = "ended_at"
        case totalTokens = "total_tokens"
        case totalCostUsd = "total_cost_usd"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = c.string(.runId)
        agentAlias = c.string(.agentAlias)
        endedAt = c.string(.endedAt)
        totalTokens = c.int(.totalTokens)
        totalCostUsd = c.double(.totalCostUsd)
    }
}

struct TokenUsageDto: Decodable, Equatable {
    /// Keyed `5h` / `7d` / `all`.
    var windows: [String: TokenMixDto] = [:]
    /// All-time, sorted by tokens desc.
    var perAgent: [TokenUsageAgentDto] = []
    var lastWake: LastWakeDto?

    enum CodingKeys: String, CodingKey {
        case windows
        case perAgent = "per_agent"
        case lastWake = "last_wake"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windows = (try? c.decodeIfPresent([String: TokenMixDto].self, forKey: .windows)) ?? [:]
        perAgent = (try? c.decodeIfPresent([TokenUsageAgentDto].self, forKey: .perAgent)) ?? []
        lastWake = (try? c.decodeIfPresent(LastWakeDto.self, forKey: .lastWake)) ?? nil
    }
}

// MARK: - Agent spend drilldown  (GET …/metrics/agents/{aid}/spend?window=)

struct SpendTaskDto: Decodable, Equatable, Identifiable {
    var taskId: String?
    var title: String?
    var status: String?
    var mix = TokenMixDto()
    var lastRunAt: String?

    var id: String { taskId ?? "__conversation__" }

    enum CodingKeys: String, CodingKey {
        case title, status
        case taskId = "task_id"
        case lastRunAt = "last_run_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = c.string(.taskId)
        title = c.string(.title)
        status = c.string(.status)
        lastRunAt = c.string(.lastRunAt)
        mix = try TokenMixDto(from: decoder)
    }
}

struct SpendAgentDto: Decodable, Equatable {
    var id: String?
    var alias: String?
    var model: String?
}

struct AgentSpendDto: Decodable, Equatable {
    var agent = SpendAgentDto()
    var window: String?
    var totals = TokenMixDto()
    var tasks: [SpendTaskDto] = []

    enum CodingKeys: String, CodingKey { case agent, window, totals, tasks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = (try? c.decodeIfPresent(SpendAgentDto.self, forKey: .agent)) ?? SpendAgentDto()
        window = c.string(.window)
        totals = (try? c.decodeIfPresent(TokenMixDto.self, forKey: .totals)) ?? TokenMixDto()
        tasks = (try? c.decodeIfPresent([SpendTaskDto].self, forKey: .tasks)) ?? []
    }
}

// MARK: - Insights  (GET …/metrics/insights?window=7d|all)

struct InsightDto: Decodable, Equatable, Identifiable {
    var id: String
    /// `high` | `medium` | `info`
    var severity: String
    var title: String
    var detail: String?
    var action: String?
    var taskId: String?
    var evidenceAlias: String?

    enum CodingKeys: String, CodingKey { case id, severity, title, detail, action, evidence }
    enum EvidenceKeys: String, CodingKey {
        case taskId = "task_id"
        case agentAlias = "agent_alias"
        case agent
    }

    init(id: String, severity: String, title: String, taskId: String? = nil, evidenceAlias: String? = nil) {
        self.id = id
        self.severity = severity
        self.title = title
        self.taskId = taskId
        self.evidenceAlias = evidenceAlias
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        severity = c.string(.severity) ?? "info"
        title = c.string(.title) ?? ""
        detail = c.string(.detail)
        action = c.string(.action)
        if let e = try? c.nestedContainer(keyedBy: EvidenceKeys.self, forKey: .evidence) {
            taskId = e.string(.taskId)
            evidenceAlias = e.string(.agentAlias) ?? e.string(.agent)
        }
    }
}

struct InsightsDto: Decodable, Equatable {
    var window: String?
    var insights: [InsightDto] = []

    enum CodingKeys: String, CodingKey { case window, insights }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = c.string(.window)
        insights = (try? c.decodeIfPresent([InsightDto].self, forKey: .insights)) ?? []
    }
}
