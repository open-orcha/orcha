import Foundation

// Responsibility: Container and agent response models decoded from the Orcha API.

// The Orcha API surface, mirrored from the Android client and proven against a live
// stack. The domain files together form one serialization contract.

struct ContainersResponse: Decodable {
    var containers: [ContainerDto] = []
}

struct ContainerSnapshot: Decodable {
    let container: ContainerDto
    var agents: [AgentDto] = []
    var tasks: [TaskDto] = []
    var requests: [RequestDto] = []
}

struct ContainerDto: Decodable {
    let id: String
    let name: String
    var description: String?
    var status: String = "unknown"
    var autonomyLevel: String?
    /// GH #148 — the wake kill-switch, distinct from `status` (the laptop-level container
    /// lifecycle). Pre-SPEC-1 snapshots may omit this; treat missing as Running (spec §6.3).
    var wakesEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, description, status
        case autonomyLevel = "autonomy_level"
        case wakesEnabled = "wakes_enabled"
    }
}

struct AgentDto: Decodable, Identifiable {
    let id: String
    let alias: String
    var role: String?
    var kind: String = "ai"
    var status: String?
    var model: String?
    var promptPreview: String?
    var wakeEnabled: Bool?
    var autoWakeIntervalSecs: Int?
    var currentTask: AgentTaskRef?
    var activeRun: ActiveRunDto?
    var lastActive: String?
    var terminatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, alias, role, kind, status, model
        case promptPreview = "prompt_preview"
        case wakeEnabled = "wake_enabled"
        case autoWakeIntervalSecs = "auto_wake_interval_secs"
        case currentTask = "current_task"
        case activeRun = "active_run"
        case lastActive = "last_active"
        case terminatedAt = "terminated_at"
    }
}

struct AgentTaskRef: Decodable {
    var taskId: String?
    var title: String?

    enum CodingKeys: String, CodingKey {
        case taskId = "task_id"
        case title
    }
}

struct ActiveRunDto: Decodable {
    let runId: String
    var wakeEvent: String?
    var wakeKind: String?
    var runtime: String?
    var taskId: String?
    var taskTitle: String?
    var hasConversation: Bool?
    var startedAt: String?

    enum CodingKeys: String, CodingKey {
        case runtime
        case runId = "run_id"
        case wakeEvent = "wake_event"
        case wakeKind = "wake_kind"
        case taskId = "task_id"
        case taskTitle = "task_title"
        case hasConversation = "has_conversation"
        case startedAt = "started_at"
    }
}
