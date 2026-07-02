import Foundation

// The Orcha API surface, mirrored from the Android client (proven against a live
// stack). One file: these types are a single serialization contract.

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

    enum CodingKeys: String, CodingKey {
        case id, name, description, status
        case autonomyLevel = "autonomy_level"
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
    var lastActive: String?
    var terminatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, alias, role, kind, status, model
        case promptPreview = "prompt_preview"
        case wakeEnabled = "wake_enabled"
        case autoWakeIntervalSecs = "auto_wake_interval_secs"
        case currentTask = "current_task"
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

struct TaskDto: Decodable, Identifiable {
    let id: String
    let title: String
    var description: String?
    var definitionOfDone: String?
    var status: String = "unknown"
    var priority: Int?
    /// tasks.result is JSONB: /done writes `{"result": <text>, "by_agent_id": …}`,
    /// legacy rows may be a bare string. Same tolerant decode as Android/portal.
    var result: String?
    var isRoot: Bool = false
    var createdByAgentId: String?
    var ownerAlias: String?
    var ownerId: String?
    var assignees: [String] = []
    var createdAt: String?
    var startedAt: String?
    var completedAt: String?
    var messageSummary: MessageSummaryDto?
    var planMessage: TaskMessageDto?
    var planDecision: String?
    var dependsOn: [String] = []

    enum CodingKeys: String, CodingKey {
        case id, title, description, status, priority, result, assignees
        case definitionOfDone = "definition_of_done"
        case isRoot = "is_root"
        case createdByAgentId = "created_by_agent_id"
        case ownerAlias = "owner_alias"
        case ownerId = "owner_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case completedAt = "completed_at"
        case messageSummary = "message_summary"
        case planMessage = "plan_message"
        case planDecision = "plan_decision"
        case dependsOn = "depends_on"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        definitionOfDone = try c.decodeIfPresent(String.self, forKey: .definitionOfDone)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        priority = try c.decodeIfPresent(Int.self, forKey: .priority)
        // tolerant result: string | {"result": string, ...} | null
        if let plain = try? c.decodeIfPresent(String.self, forKey: .result) {
            result = plain
        } else if let obj = try? c.decodeIfPresent([String: LenientValue].self, forKey: .result) {
            result = obj["result"]?.stringValue
        } else {
            result = nil
        }
        isRoot = try c.decodeIfPresent(Bool.self, forKey: .isRoot) ?? false
        createdByAgentId = try c.decodeIfPresent(String.self, forKey: .createdByAgentId)
        ownerAlias = try c.decodeIfPresent(String.self, forKey: .ownerAlias)
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId)
        assignees = try c.decodeIfPresent([String].self, forKey: .assignees) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        messageSummary = try c.decodeIfPresent(MessageSummaryDto.self, forKey: .messageSummary)
        planMessage = try c.decodeIfPresent(TaskMessageDto.self, forKey: .planMessage)
        planDecision = try c.decodeIfPresent(String.self, forKey: .planDecision)
        dependsOn = try c.decodeIfPresent([String].self, forKey: .dependsOn) ?? []
    }

    init(
        id: String, title: String, status: String = "unknown", priority: Int? = nil,
        result: String? = nil, planMessage: TaskMessageDto? = nil, planDecision: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.priority = priority
        self.result = result
        self.planMessage = planMessage
        self.planDecision = planDecision
    }
}

/// Decodes any JSON scalar/object leniently — used for the JSONB `result` shape.
enum LenientValue: Decodable {
    case string(String)
    case other

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            self = .string(s)
        } else {
            self = .other
        }
    }

    var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }
}

struct MessageSummaryDto: Decodable {
    var count: Int = 0
    var last: TaskMessageDto?
}

struct TaskMessageDto: Decodable {
    var messageId: String?
    var authorId: String?
    var authorAlias: String?
    var isHuman: Bool = false
    var body: String = ""
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case body
        case messageId = "message_id"
        case authorId = "author_id"
        case authorAlias = "author_alias"
        case isHuman = "is_human"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        authorId = try c.decodeIfPresent(String.self, forKey: .authorId)
        authorAlias = try c.decodeIfPresent(String.self, forKey: .authorAlias)
        isHuman = try c.decodeIfPresent(Bool.self, forKey: .isHuman) ?? false
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    init(body: String, authorAlias: String? = nil, authorId: String? = nil, isHuman: Bool = false, createdAt: String? = nil) {
        self.body = body
        self.authorAlias = authorAlias
        self.authorId = authorId
        self.isHuman = isHuman
        self.createdAt = createdAt
    }
}

struct RequestDto: Decodable, Identifiable {
    let id: String
    var type: String = "info"
    var status: String = "open"
    var priority: Int?
    var payload: String = ""
    var response: String?
    var rejectionReason: String?
    var requesterId: String?
    var requesterAlias: String?
    var targetId: String?
    var targetAlias: String?
    var parentRequestId: String?
    var chainDepth: Int = 0
    var createdAt: String?
    var respondedAt: String?
    var closedAt: String?
    var expiresAt: String?
    var taskLink: TaskLinkDto?

    enum CodingKeys: String, CodingKey {
        case id, type, status, priority, payload, response
        case rejectionReason = "rejection_reason"
        case requesterId = "requester_id"
        case requesterAlias = "requester_alias"
        case targetId = "target_id"
        case targetAlias = "target_alias"
        case parentRequestId = "parent_request_id"
        case chainDepth = "chain_depth"
        case createdAt = "created_at"
        case respondedAt = "responded_at"
        case closedAt = "closed_at"
        case expiresAt = "expires_at"
        case taskLink = "task_link"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "info"
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "open"
        priority = try c.decodeIfPresent(Int.self, forKey: .priority)
        payload = try c.decodeIfPresent(String.self, forKey: .payload) ?? ""
        response = try c.decodeIfPresent(String.self, forKey: .response)
        rejectionReason = try c.decodeIfPresent(String.self, forKey: .rejectionReason)
        requesterId = try c.decodeIfPresent(String.self, forKey: .requesterId)
        requesterAlias = try c.decodeIfPresent(String.self, forKey: .requesterAlias)
        targetId = try c.decodeIfPresent(String.self, forKey: .targetId)
        targetAlias = try c.decodeIfPresent(String.self, forKey: .targetAlias)
        parentRequestId = try c.decodeIfPresent(String.self, forKey: .parentRequestId)
        chainDepth = try c.decodeIfPresent(Int.self, forKey: .chainDepth) ?? 0
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        respondedAt = try c.decodeIfPresent(String.self, forKey: .respondedAt)
        closedAt = try c.decodeIfPresent(String.self, forKey: .closedAt)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        taskLink = try c.decodeIfPresent(TaskLinkDto.self, forKey: .taskLink)
    }

    init(
        id: String, type: String = "info", status: String = "open", payload: String = "",
        requesterId: String? = nil, targetId: String? = nil,
        createdAt: String? = nil, closedAt: String? = nil, expiresAt: String? = nil
    ) {
        self.id = id
        self.type = type
        self.status = status
        self.payload = payload
        self.requesterId = requesterId
        self.targetId = targetId
        self.createdAt = createdAt
        self.closedAt = closedAt
        self.expiresAt = expiresAt
    }
}

struct TaskLinkDto: Decodable {
    var taskId: String?
    var title: String?

    enum CodingKeys: String, CodingKey {
        case taskId = "task_id"
        case title
    }
}

struct TaskMessagesResponse: Decodable {
    var messages: [TaskMessageDto] = []
}

struct RunsResponse: Decodable {
    var runs: [RunDto] = []
}

struct RunDto: Decodable, Identifiable {
    let runId: String
    var agentId: String?
    var agentAlias: String?
    var taskId: String?
    var taskTitle: String?
    var status: String = "unknown"
    var wakeKind: String?
    var wakeEvent: String?
    var startedAt: String?
    var endedAt: String?

    var id: String { runId }

    enum CodingKeys: String, CodingKey {
        case status
        case runId = "run_id"
        case agentId = "agent_id"
        case agentAlias = "agent_alias"
        case taskId = "task_id"
        case taskTitle = "task_title"
        case wakeKind = "wake_kind"
        case wakeEvent = "wake_event"
        case startedAt = "started_at"
        case endedAt = "ended_at"
    }
}

struct ModelsResponse: Decodable {
    var models: [ModelDto] = []
}

struct ModelDto: Decodable, Identifiable {
    let id: String
    var name: String?
    var provider: String?
    var runtime: String?
}

struct ConversationDto: Decodable {
    let id: String
    var status: String?
}

struct ConversationResponse: Decodable {
    var conversation: ConversationDto?
    var turns: [TurnDto] = []
}

struct TurnDto: Decodable, Identifiable {
    var id: String?
    var seq: Int = 0
    var role: String = "human"
    var authorAgentId: String?
    var content: String = ""
    var runId: String?
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, seq, role, content
        case authorAgentId = "author_agent_id"
        case runId = "run_id"
        case createdAt = "created_at"
    }
}

struct PersonaResponse: Decodable {
    var alias: String?
    var role: String?
    var model: String?
    var systemPrompt: String?

    enum CodingKeys: String, CodingKey {
        case alias, role, model
        case systemPrompt = "system_prompt"
    }
}

struct DigestItem: Decodable {
    var text: String = ""
}

struct DigestDto: Decodable {
    var currentFocus: String?
    var decisions: [DigestItem] = []
    var learnings: [DigestItem] = []
    var openThreads: [DigestItem] = []
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case decisions, learnings
        case currentFocus = "current_focus"
        case openThreads = "open_threads"
        case createdAt = "created_at"
    }
}

struct DigestResponse: Decodable {
    var digest: DigestDto?
}

struct InboxResponse: Decodable {
    var openRequests: [RequestDto] = []

    enum CodingKeys: String, CodingKey {
        case openRequests = "open_requests"
    }
}

struct OutboxResponse: Decodable {
    var outgoingRequests: [RequestDto] = []

    enum CodingKeys: String, CodingKey {
        case outgoingRequests = "outgoing_requests"
    }
}

struct GenericIdResponse: Decodable {
    var taskId: String?
    var status: String?

    enum CodingKeys: String, CodingKey {
        case status
        case taskId = "task_id"
    }
}
