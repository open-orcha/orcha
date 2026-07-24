import Foundation

// Responsibility: Task and task-message response models decoded from the Orcha API.

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
        // tolerant plan_decision: null | {"decision": string, "reason", "actor", "at"} (ISS-41
        // shape — every caller only checks nil vs non-nil, never the string itself, so pulling
        // just `.decision` out preserves that contract).
        if let plain = try? c.decodeIfPresent(String.self, forKey: .planDecision) {
            planDecision = plain
        } else if let obj = try? c.decodeIfPresent([String: LenientValue].self, forKey: .planDecision) {
            planDecision = obj["decision"]?.stringValue
        } else {
            planDecision = nil
        }
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

    init(body: String, messageId: String? = nil, authorAlias: String? = nil, authorId: String? = nil, isHuman: Bool = false, createdAt: String? = nil) {
        self.body = body
        self.messageId = messageId
        self.authorAlias = authorAlias
        self.authorId = authorId
        self.isHuman = isHuman
        self.createdAt = createdAt
    }
}
