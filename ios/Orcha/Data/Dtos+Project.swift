import Foundation

// Project slice DTOs — objective (container_control_routes), agent limit (limits.py),
// project budget (budget_routes.py), performance metrics (container_metrics_routes.py),
// agent worktrees (agent_worktree_routes.py) and the full routine read for editing
// (routine_routes.py). Fields the UI can live without are optional / defaulted so an
// older or newer server never breaks decoding.

// MARK: - Objective

/// `PUT /api/containers/{cid}/objective` → `ContainerObjectiveResponse`.
struct ContainerObjectiveDto: Decodable, Equatable {
    var containerId: String?
    var objective: String?

    enum CodingKeys: String, CodingKey {
        case objective
        case containerId = "container_id"
    }
}

// MARK: - Agent limit

/// `GET/PUT /api/containers/{cid}/limits` → `ContainerLimitsResponse`.
struct ContainerLimitsDto: Decodable, Equatable {
    var maxAutoAgents: Int
    var autoAgentsInUse: Int
    var minMaxAutoAgents: Int
    var maxMaxAutoAgents: Int

    enum CodingKeys: String, CodingKey {
        case maxAutoAgents = "max_auto_agents"
        case autoAgentsInUse = "auto_agents_in_use"
        case minMaxAutoAgents = "min_max_auto_agents"
        case maxMaxAutoAgents = "max_max_auto_agents"
    }

    init(maxAutoAgents: Int, autoAgentsInUse: Int, minMaxAutoAgents: Int = 1, maxMaxAutoAgents: Int = 50) {
        self.maxAutoAgents = maxAutoAgents
        self.autoAgentsInUse = autoAgentsInUse
        self.minMaxAutoAgents = minMaxAutoAgents
        self.maxMaxAutoAgents = maxMaxAutoAgents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxAutoAgents = try c.decode(Int.self, forKey: .maxAutoAgents)
        autoAgentsInUse = try c.decodeIfPresent(Int.self, forKey: .autoAgentsInUse) ?? 0
        minMaxAutoAgents = try c.decodeIfPresent(Int.self, forKey: .minMaxAutoAgents) ?? 1
        maxMaxAutoAgents = try c.decodeIfPresent(Int.self, forKey: .maxMaxAutoAgents) ?? 50
    }
}

// MARK: - Project budget

/// `GET /api/containers/{cid}/budgets` — the project scope plus every agent's scope
/// (each scope reuses the agent slice's `AgentBudgetDto` shape).
struct ProjectBudgetsDto: Decodable {
    var period: String?
    var resetsAt: String?
    var project: AgentBudgetDto?
    var agents: [AgentBudgetDto] = []

    enum CodingKeys: String, CodingKey {
        case period, project, agents
        case resetsAt = "resets_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        period = try c.decodeIfPresent(String.self, forKey: .period)
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
        project = try? c.decodeIfPresent(AgentBudgetDto.self, forKey: .project)
        agents = (try? c.decodeIfPresent([AgentBudgetDto].self, forKey: .agents)) ?? []
    }
}

// MARK: - Performance metrics

struct PerfRateDto: Decodable, Equatable {
    var value: Double?
    var numerator = 0
    var denominator = 0
    var enough = false
}

struct PerfReworkDto: Decodable, Equatable {
    var total = 0
    var humanRejections = 0
    var managerSendBacks = 0

    enum CodingKeys: String, CodingKey {
        case total
        case humanRejections = "human_rejections"
        case managerSendBacks = "manager_send_backs"
    }
}

struct PerfMedianDto: Decodable, Equatable {
    var value: Double?
    var n = 0
    var enough = false
}

struct PerfCostDto: Decodable, Equatable {
    var value: Double?
    var meteredTasks = 0
    var unmeteredTasks = 0
    var enough = false

    enum CodingKeys: String, CodingKey {
        case value, enough
        case meteredTasks = "metered_tasks"
        case unmeteredTasks = "unmetered_tasks"
    }
}

struct PerfPlanRateDto: Decodable, Equatable {
    var value: Double?
    var denominator = 0
    var enough = false
    var approved = 0
    var rejected = 0
}

struct PerfMetricsDto: Decodable, Equatable {
    var tasksVerified: Int
    var firstPassRate: PerfRateDto
    var rework: PerfReworkDto
    var medianTimeToVerifiedSeconds: PerfMedianDto
    var costPerVerifiedTaskUsd: PerfCostDto
    var planApprovalRate: PerfPlanRateDto
    var escalations: Int

    enum CodingKeys: String, CodingKey {
        case rework, escalations
        case tasksVerified = "tasks_verified"
        case firstPassRate = "first_pass_rate"
        case medianTimeToVerifiedSeconds = "median_time_to_verified_seconds"
        case costPerVerifiedTaskUsd = "cost_per_verified_task_usd"
        case planApprovalRate = "plan_approval_rate"
    }
}

struct PerfBucketDto: Decodable, Equatable, Identifiable {
    var start: String
    var end: String?
    var verified = 0
    var rework = 0
    var id: String { start }
}

struct PerfProjectRowDto: Decodable, Equatable {
    var name: String?
    var metrics: PerfMetricsDto
    var series: [PerfBucketDto] = []
}

struct PerfAgentRowDto: Decodable, Equatable, Identifiable {
    var agentId: String
    var alias: String
    var model: String?
    var role: String?
    var retired = false
    var metrics: PerfMetricsDto
    var series: [PerfBucketDto] = []

    var id: String { agentId }

    enum CodingKeys: String, CodingKey {
        case alias, model, role, retired, metrics, series
        case agentId = "agent_id"
    }
}

/// `GET /api/containers/{cid}/metrics/performance?range=`.
struct PerformanceDto: Decodable, Equatable {
    var range: String
    var bucketDays = 1
    var minSample = 3
    var project: PerfProjectRowDto
    var agents: [PerfAgentRowDto] = []

    enum CodingKeys: String, CodingKey {
        case range, project, agents
        case bucketDays = "bucket_days"
        case minSample = "min_sample"
    }
}

/// `GET /api/containers/{cid}/metrics/performance/agents/{aid}?range=`.
struct AgentPerformanceDto: Decodable, Equatable {
    var range: String
    var minSample = 3
    var agent: PerfAgentRowDto

    enum CodingKeys: String, CodingKey {
        case range, agent
        case minSample = "min_sample"
    }
}

// MARK: - Agent worktrees

struct WorktreeSettingsDto: Decodable, Equatable {
    var autoCleanup: Bool
    var graceDays: Int

    enum CodingKeys: String, CodingKey {
        case autoCleanup = "auto_cleanup"
        case graceDays = "grace_days"
    }
}

struct WorktreeItemDto: Decodable, Equatable, Identifiable {
    var path: String
    var name: String
    var branch: String?
    var kind: String?
    var agent: String?
    var taskTitle: String?
    var state: String
    var sizeBytes: Int?
    var lastActivityAt: String?

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, name, branch, kind, agent, state
        case taskTitle = "task_title"
        case sizeBytes = "size_bytes"
        case lastActivityAt = "last_activity_at"
    }
}

struct WorktreeInventoryDto: Decodable, Equatable {
    var host: String?
    var scannedAt: String?
    var items: [WorktreeItemDto] = []
    var reclaimableBytes = 0
    var totalBytes = 0

    enum CodingKeys: String, CodingKey {
        case host, items
        case scannedAt = "scanned_at"
        case reclaimableBytes = "reclaimable_bytes"
        case totalBytes = "total_bytes"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decodeIfPresent(String.self, forKey: .host)
        scannedAt = try c.decodeIfPresent(String.self, forKey: .scannedAt)
        items = (try? c.decodeIfPresent([WorktreeItemDto].self, forKey: .items)) ?? []
        reclaimableBytes = try c.decodeIfPresent(Int.self, forKey: .reclaimableBytes) ?? 0
        totalBytes = try c.decodeIfPresent(Int.self, forKey: .totalBytes) ?? 0
    }
}

/// `GET /api/containers/{cid}/agent-worktrees`.
struct AgentWorktreesDto: Decodable, Equatable {
    var settings: WorktreeSettingsDto
    var inventory: WorktreeInventoryDto?
}

/// `POST …/agent-worktrees/actions` and `GET …/actions/{aid}`.
struct WorktreeActionDto: Decodable, Equatable {
    var id: String
    var action: String?
    /// `requested` | `claimed` | `done` | `failed`
    var status: String
    var error: String?

    var pending: Bool { status == "requested" || status == "claimed" }
}

// MARK: - Routine (full read, for the editor)

/// `GET /api/routines/{rid}` and the create / update response (`RoutineRead`).
struct RoutineReadDto: Decodable, Equatable, Identifiable {
    let id: String
    var title: String
    var description: String?
    var definitionOfDone: String
    var assigneeAgentId: String?
    var assigneeAlias: String?
    var priority: Int
    var cron: String
    var timezone: String
    var scheduleText: String
    var enabled: Bool
    var skipIfOpen: Bool

    enum CodingKeys: String, CodingKey {
        case id, title, description, priority, cron, timezone, enabled
        case definitionOfDone = "definition_of_done"
        case assigneeAgentId = "assignee_agent_id"
        case assigneeAlias = "assignee_alias"
        case scheduleText = "schedule_text"
        case skipIfOpen = "skip_if_open"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description)
        definitionOfDone = try c.decodeIfPresent(String.self, forKey: .definitionOfDone) ?? ""
        assigneeAgentId = try c.decodeIfPresent(String.self, forKey: .assigneeAgentId)
        assigneeAlias = try c.decodeIfPresent(String.self, forKey: .assigneeAlias)
        priority = try c.decodeIfPresent(Int.self, forKey: .priority) ?? 100
        cron = try c.decodeIfPresent(String.self, forKey: .cron) ?? "0 9 * * 1-5"
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? "UTC"
        scheduleText = try c.decodeIfPresent(String.self, forKey: .scheduleText) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        skipIfOpen = try c.decodeIfPresent(Bool.self, forKey: .skipIfOpen) ?? true
    }
}

/// The create / edit form's body (web `RoutineInput`).
struct RoutineInput: Equatable {
    var title: String
    var description: String?
    var definitionOfDone: String
    var assigneeAgentId: String?
    var priority: Int
    var cron: String
    var timezone: String
    var enabled: Bool
    var skipIfOpen: Bool

    /// JSON body. On edit `assignee_agent_id` is sent as explicit null to clear it.
    func json(actor: String?) -> [String: Any] {
        var body: [String: Any] = [
            "title": title,
            "description": description.map { $0 as Any } ?? NSNull(),
            "definition_of_done": definitionOfDone,
            "assignee_agent_id": assigneeAgentId.map { $0 as Any } ?? NSNull(),
            "priority": priority,
            "cron": cron,
            "timezone": timezone,
            "enabled": enabled,
            "skip_if_open": skipIfOpen,
        ]
        if let actor { body["actor_agent_id"] = actor }
        return body
    }
}
