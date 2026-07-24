import Foundation

// Responsibility: Run, model, conversation, memory, inbox, and generic API response models.

struct TurnsResponse: Decodable {
    var turns: [TurnDto] = []
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
