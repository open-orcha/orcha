import Foundation

// Agent slice DTOs — budgets (budget_routes.py), reporting lines (org_chart_routes.py),
// live run changes (run_changes_routes.py) and config history
// (agent_config_history_routes.py). Every field the UI does not strictly need is
// optional so an older/newer server never breaks decoding.

// MARK: - Budgets

struct BudgetLimits: Decodable, Equatable {
    var usd: Double?
    var tokens: Int?
}

struct BudgetUsage: Decodable, Equatable {
    var spendUsd: Double = 0
    var meteredRuns = 0
    var unmeteredRuns = 0
    var unmeteredTokens = 0
    var tokens = 0
    var runs = 0
    var inFlightRuns = 0

    enum CodingKeys: String, CodingKey {
        case tokens, runs
        case spendUsd = "spend_usd"
        case meteredRuns = "metered_runs"
        case unmeteredRuns = "unmetered_runs"
        case unmeteredTokens = "unmetered_tokens"
        case inFlightRuns = "in_flight_runs"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spendUsd = try c.decodeIfPresent(Double.self, forKey: .spendUsd) ?? 0
        meteredRuns = try c.decodeIfPresent(Int.self, forKey: .meteredRuns) ?? 0
        unmeteredRuns = try c.decodeIfPresent(Int.self, forKey: .unmeteredRuns) ?? 0
        unmeteredTokens = try c.decodeIfPresent(Int.self, forKey: .unmeteredTokens) ?? 0
        tokens = try c.decodeIfPresent(Int.self, forKey: .tokens) ?? 0
        runs = try c.decodeIfPresent(Int.self, forKey: .runs) ?? 0
        inFlightRuns = try c.decodeIfPresent(Int.self, forKey: .inFlightRuns) ?? 0
    }
}

struct BudgetOverride: Decodable, Equatable {
    var active = false
    var note: String?
}

/// One agent's budget scope (`GET /api/agents/{aid}/budget`, and each row of
/// `GET /api/containers/{cid}/budgets`.agents).
struct AgentBudgetDto: Decodable, Equatable {
    var agentId: String?
    var alias: String?
    var period: String?
    var resetsAt: String?
    var limits = BudgetLimits()
    var usage = BudgetUsage()
    /// `none` | `ok` | `warning` | `exceeded`
    var state = "none"
    var usdRatio: Double?
    var tokenRatio: Double?
    var paused = false
    var override = BudgetOverride()
    /// `agent` | `project` | nil — which cap is blocking new runs.
    var blockedBy: String?
    var reason: String?

    enum CodingKeys: String, CodingKey {
        case alias, period, limits, usage, state, paused, override, reason
        case agentId = "agent_id"
        case resetsAt = "resets_at"
        case usdRatio = "usd_ratio"
        case tokenRatio = "token_ratio"
        case blockedBy = "blocked_by"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        alias = try c.decodeIfPresent(String.self, forKey: .alias)
        period = try c.decodeIfPresent(String.self, forKey: .period)
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        limits = try c.decodeIfPresent(BudgetLimits.self, forKey: .limits) ?? BudgetLimits()
        usage = try c.decodeIfPresent(BudgetUsage.self, forKey: .usage) ?? BudgetUsage()
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "none"
        usdRatio = try c.decodeIfPresent(Double.self, forKey: .usdRatio)
        tokenRatio = try c.decodeIfPresent(Double.self, forKey: .tokenRatio)
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        override = try c.decodeIfPresent(BudgetOverride.self, forKey: .override) ?? BudgetOverride()
        blockedBy = try c.decodeIfPresent(String.self, forKey: .blockedBy)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }

    var hasLimit: Bool { limits.usd != nil || limits.tokens != nil }
    /// Runs happened but none reported a dollar figure: spend is unknown, never $0.
    var spendUnknown: Bool { usage.meteredRuns == 0 && usage.unmeteredRuns > 0 }
}

struct ContainerBudgetsDto: Decodable {
    var period: String?
    var agents: [AgentBudgetDto] = []

    enum CodingKeys: String, CodingKey { case period, agents }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = try c.decodeIfPresent(String.self, forKey: .period)
        agents = try c.decodeIfPresent([AgentBudgetDto].self, forKey: .agents) ?? []
    }
}

// MARK: - Reporting lines

struct ReportsToChainEntry: Decodable, Identifiable, Equatable {
    let id: String
    var alias: String?
    var kind: String?
    var terminated: Bool?
}

struct ReportsToDto: Decodable, Equatable {
    var agentId: String?
    var reportsToAgentId: String?
    var reportsToAlias: String?
    var chain: [ReportsToChainEntry] = []

    enum CodingKeys: String, CodingKey {
        case chain
        case agentId = "agent_id"
        case reportsToAgentId = "reports_to_agent_id"
        case reportsToAlias = "reports_to_alias"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        reportsToAgentId = try c.decodeIfPresent(String.self, forKey: .reportsToAgentId)
        reportsToAlias = try c.decodeIfPresent(String.self, forKey: .reportsToAlias)
        chain = try c.decodeIfPresent([ReportsToChainEntry].self, forKey: .chain) ?? []
    }
}

/// Minimal projection of the snapshot's agent rows — just the reporting line — so the
/// Org view groups agents without touching the shared `AgentDto`.
struct OrgSnapshotDto: Decodable {
    struct Row: Decodable {
        let id: String
        var reportsTo: String?
        enum CodingKeys: String, CodingKey {
            case id
            case reportsTo = "reports_to"
        }
    }
    var agents: [Row] = []
}

// MARK: - Live run changes

struct RunChangedFile: Decodable, Identifiable, Equatable {
    var path: String
    /// git status letter(s): `M`, `A`, `D`, `R…`, `??` (untracked).
    var status: String = "M"
    var additions: Int?
    var deletions: Int?
    var id: String { path }
}

struct RunChangesSummary: Decodable, Equatable {
    var files = 0
    var additions = 0
    var deletions = 0
}

/// `GET …/changes?since=` — either a full payload or `{unchanged:true, version}`.
struct RunChangesDto: Decodable, Equatable {
    var unchanged = false
    var available = false
    var reason: String?
    var detail: String?
    var running = false
    var source: String?
    var branch: String?
    var files: [RunChangedFile] = []
    var summary = RunChangesSummary()
    var truncated = false
    var version: String?

    enum CodingKeys: String, CodingKey {
        case unchanged, available, reason, detail, running, source, branch, files, summary, truncated, version
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unchanged = try c.decodeIfPresent(Bool.self, forKey: .unchanged) ?? false
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        source = try c.decodeIfPresent(String.self, forKey: .source)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        files = try c.decodeIfPresent([RunChangedFile].self, forKey: .files) ?? []
        summary = try c.decodeIfPresent(RunChangesSummary.self, forKey: .summary) ?? RunChangesSummary()
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        version = try c.decodeIfPresent(String.self, forKey: .version)
    }
}

struct RunDiffDto: Decodable, Equatable {
    var available = false
    var reason: String?
    var detail: String?
    var path: String?
    var diff: String?
    var binary = false
    var truncated = false

    enum CodingKeys: String, CodingKey { case available, reason, detail, path, diff, binary, truncated }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        diff = try c.decodeIfPresent(String.self, forKey: .diff)
        binary = try c.decodeIfPresent(Bool.self, forKey: .binary) ?? false
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - Config history

/// A config value on the wire: string | number | null.
enum ConfigValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let b = try? c.decode(Bool.self) { self = .string(b ? "true" : "false") }
        else { self = .null }
    }
}

struct ConfigFieldChange: Decodable, Equatable {
    var field: String
    var before: ConfigValue = .null
    var after: ConfigValue = .null
    var derived = false

    enum CodingKeys: String, CodingKey { case field, before, after, derived }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        field = try c.decode(String.self, forKey: .field)
        before = try c.decodeIfPresent(ConfigValue.self, forKey: .before) ?? .null
        after = try c.decodeIfPresent(ConfigValue.self, forKey: .after) ?? .null
        derived = try c.decodeIfPresent(Bool.self, forKey: .derived) ?? false
    }
}

struct ConfigRevisionActor: Decodable, Equatable {
    var agentId: String?
    var alias: String?
    var kind: String?
    enum CodingKeys: String, CodingKey {
        case alias, kind
        case agentId = "agent_id"
    }
}

struct ConfigRevisionDto: Decodable, Identifiable, Equatable {
    var revisionNo: Int
    /// `initial` | `change` | `restore`
    var kind: String = "change"
    var changes: [ConfigFieldChange] = []
    var actor: ConfigRevisionActor?
    var restoredFrom: Int?
    var reason: String?
    var createdAt: String?

    var id: Int { revisionNo }

    enum CodingKeys: String, CodingKey {
        case kind, changes, actor, reason
        case revisionNo = "revision_no"
        case restoredFrom = "restored_from"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revisionNo = try c.decode(Int.self, forKey: .revisionNo)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "change"
        changes = try c.decodeIfPresent([ConfigFieldChange].self, forKey: .changes) ?? []
        actor = try c.decodeIfPresent(ConfigRevisionActor.self, forKey: .actor)
        restoredFrom = try c.decodeIfPresent(Int.self, forKey: .restoredFrom)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct ConfigRevisionPageDto: Decodable {
    var latestRevisionNo: Int?
    var total = 0
    var revisions: [ConfigRevisionDto] = []
    var nextBefore: Int?

    enum CodingKeys: String, CodingKey {
        case total, revisions
        case latestRevisionNo = "latest_revision_no"
        case nextBefore = "next_before"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        latestRevisionNo = try c.decodeIfPresent(Int.self, forKey: .latestRevisionNo)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        revisions = try c.decodeIfPresent([ConfigRevisionDto].self, forKey: .revisions) ?? []
        nextBefore = try c.decodeIfPresent(Int.self, forKey: .nextBefore)
    }
}

/// `GET …/config-revisions/{rev}` — the revision plus what a restore would change.
struct ConfigRevisionDetailDto: Decodable {
    struct PreviewItem: Decodable, Equatable {
        var field: String
        var current: ConfigValue = .null
        var target: ConfigValue = .null
        var grant: String?

        enum CodingKeys: String, CodingKey { case field, current, target, grant }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            field = try c.decode(String.self, forKey: .field)
            current = try c.decodeIfPresent(ConfigValue.self, forKey: .current) ?? .null
            target = try c.decodeIfPresent(ConfigValue.self, forKey: .target) ?? .null
            grant = try c.decodeIfPresent(String.self, forKey: .grant)
        }
    }

    struct Blocked: Decodable, Equatable {
        var field: String
        var reason: String
    }

    var revisionNo: Int
    var restorePreview: [PreviewItem] = []
    var restoreBlocked: [Blocked] = []

    enum CodingKeys: String, CodingKey {
        case revisionNo = "revision_no"
        case restorePreview = "restore_preview"
        case restoreBlocked = "restore_blocked"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revisionNo = try c.decode(Int.self, forKey: .revisionNo)
        restorePreview = try c.decodeIfPresent([PreviewItem].self, forKey: .restorePreview) ?? []
        restoreBlocked = try c.decodeIfPresent([Blocked].self, forKey: .restoreBlocked) ?? []
    }
}

struct ConfigRestoreResultDto: Decodable {
    var restoredFrom: Int?
    var applied: [String] = []

    enum CodingKeys: String, CodingKey {
        case applied
        case restoredFrom = "restored_from"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        restoredFrom = try c.decodeIfPresent(Int.self, forKey: .restoredFrom)
        applied = try c.decodeIfPresent([String].self, forKey: .applied) ?? []
    }
}
