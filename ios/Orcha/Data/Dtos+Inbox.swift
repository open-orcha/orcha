import Foundation

// MARK: - Requests: the fields the snapshot's RequestDto leaves out (mig 065 + auto-resolve)

/// `GET /api/containers/{cid}/requests` rows, decoded only for what the request
/// detail needs on top of the snapshot's `RequestDto`. `agentPayload` is decoded so the
/// split is explicit, but it is the AGENT's instructions — never rendered to a person.
struct InboxRequestExtrasDto: Decodable, Equatable {
    let id: String
    var payload: String?
    var agentPayload: String?
    var detail: InboxRequestDetailDto?
    var closedByAlias: String?
    var closeDecision: InboxCloseDecisionDto?

    enum CodingKeys: String, CodingKey {
        case id, payload, detail
        case agentPayload = "agent_payload"
        case closedByAlias = "closed_by_alias"
        case closeDecision = "close_decision"
    }

    init(id: String, payload: String? = nil, agentPayload: String? = nil, detail: InboxRequestDetailDto? = nil,
         closedByAlias: String? = nil, closeDecision: InboxCloseDecisionDto? = nil) {
        self.id = id
        self.payload = payload
        self.agentPayload = agentPayload
        self.detail = detail
        self.closedByAlias = closedByAlias
        self.closeDecision = closeDecision
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        payload = try? c.decodeIfPresent(String.self, forKey: .payload)
        agentPayload = try? c.decodeIfPresent(String.self, forKey: .agentPayload)
        // `detail` is a free-form jsonb bag: decode leniently, never fail the row on it.
        detail = try? c.decodeIfPresent(InboxRequestDetailDto.self, forKey: .detail)
        closedByAlias = try? c.decodeIfPresent(String.self, forKey: .closedByAlias)
        closeDecision = try? c.decodeIfPresent(InboxCloseDecisionDto.self, forKey: .closeDecision)
    }
}

/// The known keys of `requests.detail` (everything else is ignored).
struct InboxRequestDetailDto: Decodable, Equatable {
    /// `"thread_answered"` | `"thread_resolved"` — the backend closed it for you.
    var autoResolved: String?
    var displayTitle: String?
    var codeThread: InboxCodeThreadDto?

    enum CodingKeys: String, CodingKey {
        case autoResolved = "auto_resolved"
        case displayTitle = "display_title"
        case codeThread = "code_thread"
    }

    init(autoResolved: String? = nil, displayTitle: String? = nil, codeThread: InboxCodeThreadDto? = nil) {
        self.autoResolved = autoResolved
        self.displayTitle = displayTitle
        self.codeThread = codeThread
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        autoResolved = try? c.decodeIfPresent(String.self, forKey: .autoResolved)
        displayTitle = try? c.decodeIfPresent(String.self, forKey: .displayTitle)
        codeThread = try? c.decodeIfPresent(InboxCodeThreadDto.self, forKey: .codeThread)
    }
}

struct InboxCodeThreadDto: Decodable, Equatable {
    var threadId: String?
    var kind: String?
    var path: String?
    var link: String?

    enum CodingKeys: String, CodingKey {
        case kind, path, link
        case threadId = "thread_id"
    }
}

struct InboxCloseDecisionDto: Decodable, Equatable {
    var reason: String?
    var actor: String?
}

struct InboxRequestListResponse: Decodable {
    var requests: [InboxRequestExtrasDto] = []
}

// MARK: - Notification preferences (mig 063)

struct NotifRule: Codable, Equatable {
    var scope: String
    var channels: [String: Bool]
}

/// A project override for one category — either half may be absent.
struct NotifPartialRule: Codable, Equatable {
    var scope: String?
    var channels: [String: Bool]?
}

struct NotifPause: Codable, Equatable {
    /// Epoch seconds; nil = "until I turn it back on".
    var until: Double?
}

struct NotifQuietHours: Codable, Equatable {
    var start: String
    var end: String
    var tz: String
}

struct NotifCategory: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    var description: String?
    var id: String { key }
}

struct NotifChannel: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    var alert: Bool?
    var id: String { key }
}

struct NotifScope: Decodable, Equatable {
    let key: String
    let label: String
}

struct NotifLock: Decodable, Equatable {
    let category: String
    let channel: String
    var reason: String?
}

struct NotifCatalog: Decodable, Equatable {
    var categories: [NotifCategory] = []
    var channels: [NotifChannel] = []
    var scopes: [NotifScope] = []
    var locks: [NotifLock] = []
}

struct NotifChannelAvailability: Decodable, Equatable {
    var available: Bool
    var reason: String?
}

struct NotifDefaults: Decodable, Equatable {
    var rules: [String: NotifRule] = [:]
    var pause: NotifPause?
    var quietHours: NotifQuietHours?
    var stored: Bool = false

    enum CodingKeys: String, CodingKey {
        case rules, pause, stored
        case quietHours = "quiet_hours"
    }
}

struct NotifProject: Decodable, Equatable {
    var rules: [String: NotifPartialRule] = [:]
    var muted: Bool = false
    var stored: Bool = false
}

struct NotifEffective: Decodable, Equatable {
    var rules: [String: NotifRule] = [:]
    var pause: NotifPause?
    var quietHours: NotifQuietHours?
    var muted: Bool = false
    var pausedNow: Bool = false
    var quietNow: Bool?

    enum CodingKeys: String, CodingKey {
        case rules, pause, muted
        case quietHours = "quiet_hours"
        case pausedNow = "paused_now"
        case quietNow = "quiet_now"
    }
}

/// `GET/PUT/DELETE /api/containers/{cid}/notification-prefs[/defaults]` — every route
/// answers this same view of the acting member's settings.
struct NotificationPrefsDto: Decodable, Equatable {
    var catalog: NotifCatalog
    var channels: [String: NotifChannelAvailability] = [:]
    var defaults: NotifDefaults
    var project: NotifProject
    var effective: NotifEffective
    var editable: Bool = true
}

// MARK: - Routines

struct RoutineLastRunDto: Decodable, Equatable {
    var runId: String?
    var outcome: String
    var trigger: String?
    var detail: String?
    var createdAt: String?
    var taskId: String?
    var taskTitle: String?
    var taskStatus: String?

    enum CodingKeys: String, CodingKey {
        case outcome, trigger, detail
        case runId = "run_id"
        case createdAt = "created_at"
        case taskId = "task_id"
        case taskTitle = "task_title"
        case taskStatus = "task_status"
    }
}

struct RoutineDto: Decodable, Equatable, Identifiable, Hashable {
    let id: String
    var title: String
    var titlePreview: String?
    var description: String?
    var assigneeAlias: String?
    var scheduleText: String
    var timezone: String?
    var enabled: Bool
    var skipIfOpen: Bool
    var nextRunAt: String?
    var lastRunAt: String?
    var lastRun: RoutineLastRunDto?

    enum CodingKeys: String, CodingKey {
        case id, title, description, timezone, enabled
        case titlePreview = "title_preview"
        case assigneeAlias = "assignee_alias"
        case scheduleText = "schedule_text"
        case skipIfOpen = "skip_if_open"
        case nextRunAt = "next_run_at"
        case lastRunAt = "last_run_at"
        case lastRun = "last_run"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        titlePreview = try c.decodeIfPresent(String.self, forKey: .titlePreview)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        assigneeAlias = try c.decodeIfPresent(String.self, forKey: .assigneeAlias)
        scheduleText = try c.decodeIfPresent(String.self, forKey: .scheduleText) ?? ""
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        skipIfOpen = try c.decodeIfPresent(Bool.self, forKey: .skipIfOpen) ?? true
        nextRunAt = try c.decodeIfPresent(String.self, forKey: .nextRunAt)
        lastRunAt = try c.decodeIfPresent(String.self, forKey: .lastRunAt)
        lastRun = try? c.decodeIfPresent(RoutineLastRunDto.self, forKey: .lastRun)
    }

    static func == (lhs: RoutineDto, rhs: RoutineDto) -> Bool {
        lhs.id == rhs.id && lhs.enabled == rhs.enabled && lhs.nextRunAt == rhs.nextRunAt
            && lhs.lastRun == rhs.lastRun && lhs.title == rhs.title
    }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// The next task's title (server preview when given, else the stored title).
    var displayTitle: String { titlePreview?.isEmpty == false ? titlePreview! : title }
}

struct RoutineSchedulerDto: Decodable, Equatable {
    var lastTickAt: String?
    enum CodingKeys: String, CodingKey { case lastTickAt = "last_tick_at" }
}

struct RoutineListResponse: Decodable {
    var routines: [RoutineDto] = []
    var scheduler: RoutineSchedulerDto?
}

struct RoutineRunDto: Decodable, Equatable, Identifiable {
    let runId: String
    var trigger: String?
    var outcome: String
    var scheduledFor: String?
    var missedCount: Int?
    var taskId: String?
    var taskTitle: String?
    var taskStatus: String?
    var detail: String?
    var actorAlias: String?
    var createdAt: String?

    var id: String { runId }

    enum CodingKeys: String, CodingKey {
        case trigger, outcome, detail
        case runId = "run_id"
        case scheduledFor = "scheduled_for"
        case missedCount = "missed_count"
        case taskId = "task_id"
        case taskTitle = "task_title"
        case taskStatus = "task_status"
        case actorAlias = "actor_alias"
        case createdAt = "created_at"
    }
}

struct RoutineRunsResponse: Decodable {
    var runs: [RoutineRunDto] = []
}

struct RoutineRunResult: Decodable {
    var runId: String?
    var outcome: String
    var taskId: String?
    var detail: String?

    enum CodingKeys: String, CodingKey {
        case outcome, detail
        case runId = "run_id"
        case taskId = "task_id"
    }
}
