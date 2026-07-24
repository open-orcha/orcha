import Foundation

// Responsibility: Request, task-link, nudge, and task-thread paging response models.

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
        priority: Int? = nil, requesterId: String? = nil, targetId: String? = nil,
        createdAt: String? = nil, closedAt: String? = nil, expiresAt: String? = nil
    ) {
        self.id = id
        self.type = type
        self.status = status
        self.payload = payload
        self.priority = priority
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

/// Flow 07a — the nudge outcome (`main.py:7762-7801`). `nudged:false` is a clean no-op
/// (the routed next-action owner is a human / the nudger) — informational, not an error.
struct NudgeResult: Decodable {
    var nudged: Bool = false
    var nudgedRole: String?
    var nudgedAgentId: String?

    enum CodingKeys: String, CodingKey {
        case nudged
        case nudgedRole = "nudged_role"
        case nudgedAgentId = "nudged_agent_id"
    }
}

struct TaskMessagesResponse: Decodable {
    var messages: [TaskMessageDto] = []
    /// ISS-68 keyset paging (`main.py:5940`): present only when `limit`>0 was requested.
    var hasMore: Bool = false
    var nextBefore: String?
    var nextBeforeId: String?

    enum CodingKeys: String, CodingKey {
        case messages
        case hasMore = "has_more"
        case nextBefore = "next_before"
        case nextBeforeId = "next_before_id"
    }
}
