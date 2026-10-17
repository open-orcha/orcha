import Foundation

/* =============================================================================
   Task slice DTOs — evidence pack (proof of work), Verdikt runs, goal ancestry,
   routines ("Make recurring…"), reassign and the AI manager pre-review.
   Shapes mirror the portal backend (evidence_routes.py, verdikt_integration.run_public,
   goal_ancestry_routes.py, routine_routes.py, task_assignment_routes.py) and the web
   `evidenceTypes.ts`. Every field is optional/defaulted: an older server that lacks a
   key must still decode.
   ============================================================================= */

// MARK: - evidence pack

/// `GET /api/tasks/{tid}/evidence`.
struct EvidencePackDto: Decodable, Equatable {
    var taskId: String?
    var builtAt: String?
    var roundStartedAt: String?
    var runs: [EvidenceRunDto] = []
    var tests: EvidenceTestsDto?
    var changes: EvidenceChangesDto?
    var flags: [RiskFlagDto] = []
    var branch: String?
    var prUrls: [String] = []
    var links: [EvidenceLinkDto] = []
    var dod: EvidenceDodDto?
    var verdikt: VerdiktRunDto?
    var summary: EvidenceSummaryDto?

    enum CodingKeys: String, CodingKey {
        case runs, tests, changes, flags, branch, links, dod, verdikt, summary
        case taskId = "task_id"
        case builtAt = "built_at"
        case roundStartedAt = "round_started_at"
        case prUrls = "pr_urls"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        builtAt = try? c.decodeIfPresent(String.self, forKey: .builtAt)
        roundStartedAt = try? c.decodeIfPresent(String.self, forKey: .roundStartedAt)
        runs = (try? c.decodeIfPresent([EvidenceRunDto].self, forKey: .runs)) ?? []
        tests = try? c.decodeIfPresent(EvidenceTestsDto.self, forKey: .tests)
        changes = try? c.decodeIfPresent(EvidenceChangesDto.self, forKey: .changes)
        flags = (try? c.decodeIfPresent([RiskFlagDto].self, forKey: .flags)) ?? []
        branch = try? c.decodeIfPresent(String.self, forKey: .branch)
        prUrls = (try? c.decodeIfPresent([String].self, forKey: .prUrls)) ?? []
        links = (try? c.decodeIfPresent([EvidenceLinkDto].self, forKey: .links)) ?? []
        dod = try? c.decodeIfPresent(EvidenceDodDto.self, forKey: .dod)
        verdikt = try? c.decodeIfPresent(VerdiktRunDto.self, forKey: .verdikt)
        summary = try? c.decodeIfPresent(EvidenceSummaryDto.self, forKey: .summary)
    }
}

struct EvidenceRunDto: Decodable, Equatable {
    var runId: String?
    var status: String?

    enum CodingKeys: String, CodingKey {
        case status
        case runId = "run_id"
    }
}

struct EvidenceDodDto: Decodable, Equatable {
    var items: [DodItemDto] = []
    var total: Int = 0
    var proven: Int = 0
    var notProven: Int = 0
    var needsHuman: Int = 0

    enum CodingKeys: String, CodingKey {
        case items, total, proven
        case notProven = "not_proven"
        case needsHuman = "needs_human"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([DodItemDto].self, forKey: .items)) ?? []
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? items.count
        proven = (try? c.decodeIfPresent(Int.self, forKey: .proven)) ?? 0
        notProven = (try? c.decodeIfPresent(Int.self, forKey: .notProven)) ?? 0
        needsHuman = (try? c.decodeIfPresent(Int.self, forKey: .needsHuman)) ?? 0
    }
}

/// One definition-of-done line: `status` is proven | not_proven | needs_human.
struct DodItemDto: Decodable, Equatable, Identifiable {
    var index: Int
    var text: String
    var status: String
    var evidence: String?
    var claim: String?

    var id: Int { index }

    enum CodingKeys: String, CodingKey { case index, text, status, evidence, claim }

    init(index: Int, text: String, status: String, evidence: String? = nil, claim: String? = nil) {
        self.index = index
        self.text = text
        self.status = status
        self.evidence = evidence
        self.claim = claim
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        index = (try? c.decodeIfPresent(Int.self, forKey: .index)) ?? 0
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "needs_human"
        evidence = try? c.decodeIfPresent(String.self, forKey: .evidence)
        claim = try? c.decodeIfPresent(String.self, forKey: .claim)
    }
}

struct EvidenceTestsDto: Decodable, Equatable {
    /// none | passed | failed | exit_ok | unverified
    var status: String = "none"
    var passed: Int = 0
    var failed: Int = 0
    var skipped: Int = 0
    var errors: Int = 0
    var latest: [TestInvocationDto] = []
    var earlier: Int = 0

    enum CodingKeys: String, CodingKey { case status, passed, failed, skipped, errors, latest, earlier }

    init(status: String = "none", passed: Int = 0, failed: Int = 0, skipped: Int = 0, errors: Int = 0) {
        self.status = status
        self.passed = passed
        self.failed = failed
        self.skipped = skipped
        self.errors = errors
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "none"
        passed = (try? c.decodeIfPresent(Int.self, forKey: .passed)) ?? 0
        failed = (try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? 0
        skipped = (try? c.decodeIfPresent(Int.self, forKey: .skipped)) ?? 0
        errors = (try? c.decodeIfPresent(Int.self, forKey: .errors)) ?? 0
        latest = (try? c.decodeIfPresent([TestInvocationDto].self, forKey: .latest)) ?? []
        earlier = (try? c.decodeIfPresent(Int.self, forKey: .earlier)) ?? 0
    }
}

struct TestInvocationDto: Decodable, Equatable {
    var framework: String?
    var command: String?
    var exitCode: Int?
    var counts: TestCountsDto?
    /// passed | failed | no_tests | exit_ok | exit_failed | unknown
    var outcome: String?

    enum CodingKeys: String, CodingKey {
        case framework, command, counts, outcome
        case exitCode = "exit_code"
    }
}

struct TestCountsDto: Decodable, Equatable {
    var passed: Int = 0
    var failed: Int = 0
    var skipped: Int = 0
    var errors: Int = 0
    var unit: String?

    enum CodingKeys: String, CodingKey { case passed, failed, skipped, errors, unit }

    init(passed: Int = 0, failed: Int = 0, skipped: Int = 0, errors: Int = 0, unit: String? = "tests") {
        self.passed = passed
        self.failed = failed
        self.skipped = skipped
        self.errors = errors
        self.unit = unit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        passed = (try? c.decodeIfPresent(Int.self, forKey: .passed)) ?? 0
        failed = (try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? 0
        skipped = (try? c.decodeIfPresent(Int.self, forKey: .skipped)) ?? 0
        errors = (try? c.decodeIfPresent(Int.self, forKey: .errors)) ?? 0
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
    }
}

struct EvidenceChangesDto: Decodable, Equatable {
    var files: Int?
    var additions: Int?
    var deletions: Int?
    var summary: String?
}

struct RiskFlagDto: Decodable, Equatable, Identifiable {
    var kind: String
    var label: String
    var detail: String?
    /// warn | danger
    var severity: String?
    var files: [String] = []

    var id: String { kind }

    enum CodingKeys: String, CodingKey { case kind, label, detail, severity, files }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "risk"
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? "Risk"
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        severity = try? c.decodeIfPresent(String.self, forKey: .severity)
        files = (try? c.decodeIfPresent([String].self, forKey: .files)) ?? []
    }
}

struct EvidenceLinkDto: Decodable, Equatable {
    var kind: String?
    var label: String
    var href: String
}

/// `summary` on the pack — the one-line counts the compact row renders.
struct EvidenceSummaryDto: Decodable, Equatable {
    var dod: EvidenceDodCounts?
    var tests: EvidenceTestsDto?
    var riskFlags: Int = 0
    var verdikt: VerdiktBriefDto?
    var autofix: AutofixSummaryDto?

    enum CodingKeys: String, CodingKey {
        case dod, tests, verdikt, autofix
        case riskFlags = "risk_flags"
    }

    init(dod: EvidenceDodCounts? = nil, tests: EvidenceTestsDto? = nil, riskFlags: Int = 0,
         verdikt: VerdiktBriefDto? = nil, autofix: AutofixSummaryDto? = nil) {
        self.dod = dod
        self.tests = tests
        self.riskFlags = riskFlags
        self.verdikt = verdikt
        self.autofix = autofix
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dod = try? c.decodeIfPresent(EvidenceDodCounts.self, forKey: .dod)
        tests = try? c.decodeIfPresent(EvidenceTestsDto.self, forKey: .tests)
        riskFlags = (try? c.decodeIfPresent(Int.self, forKey: .riskFlags)) ?? 0
        verdikt = try? c.decodeIfPresent(VerdiktBriefDto.self, forKey: .verdikt)
        autofix = try? c.decodeIfPresent(AutofixSummaryDto.self, forKey: .autofix)
    }
}

struct EvidenceDodCounts: Decodable, Equatable {
    var total: Int = 0
    var proven: Int = 0
    var notProven: Int = 0
    var needsHuman: Int = 0

    enum CodingKeys: String, CodingKey {
        case total, proven
        case notProven = "not_proven"
        case needsHuman = "needs_human"
    }

    init(total: Int, proven: Int, notProven: Int = 0, needsHuman: Int = 0) {
        self.total = total
        self.proven = proven
        self.notProven = notProven
        self.needsHuman = needsHuman
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? 0
        proven = (try? c.decodeIfPresent(Int.self, forKey: .proven)) ?? 0
        notProven = (try? c.decodeIfPresent(Int.self, forKey: .notProven)) ?? 0
        needsHuman = (try? c.decodeIfPresent(Int.self, forKey: .needsHuman)) ?? 0
    }
}

struct VerdiktBriefDto: Decodable, Equatable {
    var status: String
    var verdict: String?
}

/// The Verdikt auto-fix loop's compact state (mig 068).
struct AutofixSummaryDto: Decodable, Equatable {
    var status: String
    var attemptsMade: Int = 0
    var maxAttempts: Int = 0
    var currentAttempt: Int = 0
    var stopKind: String?
    var stopReason: String?

    enum CodingKeys: String, CodingKey {
        case status
        case attemptsMade = "attempts_made"
        case maxAttempts = "max_attempts"
        case currentAttempt = "current_attempt"
        case stopKind = "stop_kind"
        case stopReason = "stop_reason"
    }
}

// MARK: - Verdikt

/// One Verdikt run (`verdikt_integration.run_public`).
struct VerdiktRunDto: Decodable, Equatable, Identifiable {
    let id: String
    /// manual | auto
    var trigger: String?
    /// queued | running | completed | failed | cancelled | timeout | unavailable
    var status: String
    /// pass | fail | blocked | warning | unprocessable | running
    var verdict: String?
    var reason: String?
    var targetKind: String?
    var locator: String?
    /// Portal-relative redirect to Verdikt's report.
    var reportUrl: String?
    var error: String?
    var createdAt: String?
    var finishedAt: String?
    var verdiktRunId: String?

    enum CodingKeys: String, CodingKey {
        case id, trigger, status, verdict, reason, locator, error
        case targetKind = "target_kind"
        case reportUrl = "report_url"
        case createdAt = "created_at"
        case finishedAt = "finished_at"
        case verdiktRunId = "verdikt_run_id"
    }
}

/// `GET /api/tasks/{tid}/verdikt/runs`.
struct VerdiktRunsResponse: Decodable {
    var settings: VerdiktSettingsBrief?
    var runs: [VerdiktRunDto] = []

    enum CodingKeys: String, CodingKey { case settings, runs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try? c.decodeIfPresent(VerdiktSettingsBrief.self, forKey: .settings)
        runs = (try? c.decodeIfPresent([VerdiktRunDto].self, forKey: .runs)) ?? []
    }
}

struct VerdiktSettingsBrief: Decodable, Equatable {
    var configured: Bool = false
    var enabled: Bool = false
    var baseUrl: String?

    enum CodingKeys: String, CodingKey {
        case configured, enabled
        case baseUrl = "base_url"
    }

    init(configured: Bool, enabled: Bool, baseUrl: String? = nil) {
        self.configured = configured
        self.enabled = enabled
        self.baseUrl = baseUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = (try? c.decodeIfPresent(Bool.self, forKey: .configured)) ?? false
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        baseUrl = try? c.decodeIfPresent(String.self, forKey: .baseUrl)
    }
}

// MARK: - goal ancestry

/// `GET /api/tasks/{tid}/goal-chain` → objective › parent… › this task.
struct GoalChainDto: Decodable, Equatable {
    var taskId: String?
    var goalChain: [GoalNodeDto] = []
    var truncated: Bool = false
    var cycle: Bool = false

    enum CodingKeys: String, CodingKey {
        case truncated, cycle
        case taskId = "task_id"
        case goalChain = "goal_chain"
    }

    init(goalChain: [GoalNodeDto], truncated: Bool = false, cycle: Bool = false) {
        self.goalChain = goalChain
        self.truncated = truncated
        self.cycle = cycle
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        goalChain = (try? c.decodeIfPresent([GoalNodeDto].self, forKey: .goalChain)) ?? []
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        cycle = (try? c.decodeIfPresent(Bool.self, forKey: .cycle)) ?? false
    }
}

struct GoalNodeDto: Decodable, Equatable {
    /// objective | parent | task
    var kind: String
    var id: String?
    var title: String
    /// Objective only: the stated objective (nil = none set).
    var text: String?
    var status: String?
    /// Parent only: parent_link | task_request
    var via: String?

    enum CodingKeys: String, CodingKey { case kind, id, title, text, status, via }

    init(kind: String, id: String? = nil, title: String, text: String? = nil, status: String? = nil, via: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.text = text
        self.status = status
        self.via = via
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "parent"
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        via = try? c.decodeIfPresent(String.self, forKey: .via)
    }
}

// MARK: - manager pre-review

/// `tasks.manager_review` (mig 057) — the AI manager's advisory pre-review.
struct ManagerReviewDto: Decodable, Equatable {
    /// pending | approved | sent_back | commented | superseded | overridden
    var status: String?
    var managerAlias: String?
    var reasons: String?
    var decidedAt: String?

    enum CodingKeys: String, CodingKey {
        case status, reasons
        case managerAlias = "manager_alias"
        case decidedAt = "decided_at"
    }
}

/// Slim per-task read of the fields the shared `TaskDto` doesn't carry — decoded from
/// the same snapshot task rows (`manager_review` rides `_task_list_sql`).
struct TaskReviewExtrasDto: Decodable {
    let id: String
    var managerReview: ManagerReviewDto?
    var reviewRouting: ReviewRoutingDto?

    enum CodingKeys: String, CodingKey {
        case id
        case managerReview = "manager_review"
        case reviewRouting = "review_routing"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        managerReview = try? c.decodeIfPresent(ManagerReviewDto.self, forKey: .managerReview)
        reviewRouting = try? c.decodeIfPresent(ReviewRoutingDto.self, forKey: .reviewRouting)
    }
}

/// Who a verify was routed to and why (mig 057 `review_routing`, web `ReviewRouteRow`).
struct ReviewRoutingDto: Decodable, Equatable {
    var routedVia: String?
    var managerDepth: Int?
    var assigneeAlias: String?
    var reviewerAlias: String?
    var setByAlias: String?

    enum CodingKeys: String, CodingKey {
        case routedVia = "routed_via"
        case managerDepth = "manager_depth"
        case assigneeAlias = "assignee_alias"
        case reviewerAlias = "reviewer_alias"
        case setByAlias = "set_by_alias"
    }
}

// MARK: - routines

/// `POST /api/containers/{cid}/routines/preview`.
struct TaskRoutinePreviewDto: Decodable, Equatable {
    var valid: Bool = false
    var error: String?
    var scheduleText: String?
    var nextRuns: [String] = []

    enum CodingKeys: String, CodingKey {
        case valid, error
        case scheduleText = "schedule_text"
        case nextRuns = "next_runs"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        valid = (try? c.decodeIfPresent(Bool.self, forKey: .valid)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        scheduleText = try? c.decodeIfPresent(String.self, forKey: .scheduleText)
        nextRuns = (try? c.decodeIfPresent([String].self, forKey: .nextRuns)) ?? []
    }
}

/// The created routine (only what the confirmation toast reads).
struct TaskRoutineCreatedDto: Decodable {
    var id: String?
    var scheduleText: String?

    enum CodingKeys: String, CodingKey {
        case id
        case scheduleText = "schedule_text"
    }
}

// MARK: - reassign

/// `POST /api/tasks/{tid}/assign`.
struct AssignResultDto: Decodable {
    var alias: String?
    var status: String?
    var woke: Bool?
}

// MARK: - close implications (task_impact_routes.py)

/// The `summary` block of `GET /api/tasks/{tid}/close-implications` — counts only.
struct CloseImplicationsSummaryDto: Decodable, Equatable {
    var downstreamTotal = 0
    var wouldUnblock = 0
    var stillBlocked = 0
    var inFlightAgents = 0
    var openRequests = 0
    var completesContainer = false

    enum CodingKeys: String, CodingKey {
        case downstreamTotal = "downstream_total"
        case wouldUnblock = "would_unblock"
        case stillBlocked = "still_blocked"
        case inFlightAgents = "in_flight_agents"
        case openRequests = "open_requests"
        case completesContainer = "completes_container"
    }

    init(downstreamTotal: Int = 0, wouldUnblock: Int = 0, stillBlocked: Int = 0,
         inFlightAgents: Int = 0, openRequests: Int = 0, completesContainer: Bool = false) {
        self.downstreamTotal = downstreamTotal
        self.wouldUnblock = wouldUnblock
        self.stillBlocked = stillBlocked
        self.inFlightAgents = inFlightAgents
        self.openRequests = openRequests
        self.completesContainer = completesContainer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        downstreamTotal = (try? c.decodeIfPresent(Int.self, forKey: .downstreamTotal)) ?? 0
        wouldUnblock = (try? c.decodeIfPresent(Int.self, forKey: .wouldUnblock)) ?? 0
        stillBlocked = (try? c.decodeIfPresent(Int.self, forKey: .stillBlocked)) ?? 0
        inFlightAgents = (try? c.decodeIfPresent(Int.self, forKey: .inFlightAgents)) ?? 0
        openRequests = (try? c.decodeIfPresent(Int.self, forKey: .openRequests)) ?? 0
        completesContainer = (try? c.decodeIfPresent(Bool.self, forKey: .completesContainer)) ?? false
    }
}

/// `GET /api/tasks/{tid}/close-implications` — the blast radius of closing a task.
/// `implications` (free-text lines) is a tolerant extra for servers that offer copy.
struct CloseImplicationsDto: Decodable, Equatable {
    var taskId: String?
    var isRoot = false
    var summary: CloseImplicationsSummaryDto?
    var implications: [String] = []

    enum CodingKeys: String, CodingKey {
        case summary, implications
        case taskId = "task_id"
        case isRoot = "is_root"
    }

    init(summary: CloseImplicationsSummaryDto?, implications: [String] = []) {
        self.summary = summary
        self.implications = implications
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        isRoot = (try? c.decodeIfPresent(Bool.self, forKey: .isRoot)) ?? false
        summary = try? c.decodeIfPresent(CloseImplicationsSummaryDto.self, forKey: .summary)
        implications = (try? c.decodeIfPresent([String].self, forKey: .implications)) ?? []
    }
}

// MARK: - deliverables (deliverables_routes.py)

/// One stored version of a deliverable (`_version_json`).
struct DeliverableVersionDto: Decodable, Equatable, Identifiable {
    var version: Int
    var source: String = "attached"
    var runId: String?
    var authorAgentId: String?
    var authorAlias: String?
    var authorKind: String?
    var sizeBytes: Int?
    var sha256: String?
    var contentType: String?
    var note: String?
    var createdAt: String?

    var id: Int { version }

    enum CodingKeys: String, CodingKey {
        case version, source, sha256, note
        case runId = "run_id"
        case authorAgentId = "author_agent_id"
        case authorAlias = "author_alias"
        case authorKind = "author_kind"
        case sizeBytes = "size_bytes"
        case contentType = "content_type"
        case createdAt = "created_at"
    }

    init(version: Int, source: String = "attached", authorAlias: String? = nil, sizeBytes: Int? = nil) {
        self.version = version
        self.source = source
        self.authorAlias = authorAlias
        self.sizeBytes = sizeBytes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? 1
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "attached"
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        authorAgentId = try? c.decodeIfPresent(String.self, forKey: .authorAgentId)
        authorAlias = try? c.decodeIfPresent(String.self, forKey: .authorAlias)
        authorKind = try? c.decodeIfPresent(String.self, forKey: .authorKind)
        sizeBytes = try? c.decodeIfPresent(Int.self, forKey: .sizeBytes)
        sha256 = try? c.decodeIfPresent(String.self, forKey: .sha256)
        contentType = try? c.decodeIfPresent(String.self, forKey: .contentType)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// One deliverable (`_deliverable_json`); `versions` only on the detail read.
struct DeliverableDto: Decodable, Equatable, Identifiable, Hashable {
    var id: String
    var taskId: String?
    var path: String = ""
    var name: String = ""
    var kind: String = "text"
    var latestVersion = 1
    var versionCount = 1
    var createdAt: String?
    var updatedAt: String?
    var latest: DeliverableVersionDto?
    var versions: [DeliverableVersionDto]?

    enum CodingKeys: String, CodingKey {
        case id, path, name, kind, latest, versions
        case taskId = "task_id"
        case latestVersion = "latest_version"
        case versionCount = "version_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    static func == (a: Self, b: Self) -> Bool {
        a.id == b.id && a.latestVersion == b.latestVersion && a.versions == b.versions
    }
    func hash(into hasher: inout Hasher) { hasher.combine(id); hasher.combine(latestVersion) }

    init(id: String, path: String, kind: String, latestVersion: Int = 1, versionCount: Int = 1, latest: DeliverableVersionDto? = nil) {
        self.id = id
        self.path = path
        self.name = String(path.split(separator: "/").last ?? Substring(path))
        self.kind = kind
        self.latestVersion = latestVersion
        self.versionCount = versionCount
        self.latest = latest
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""
        let fallbackName = String(path.split(separator: "/").last ?? "")
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? fallbackName
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "text"
        latestVersion = (try? c.decodeIfPresent(Int.self, forKey: .latestVersion)) ?? 1
        versionCount = (try? c.decodeIfPresent(Int.self, forKey: .versionCount)) ?? 1
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
        latest = try? c.decodeIfPresent(DeliverableVersionDto.self, forKey: .latest)
        versions = try? c.decodeIfPresent([DeliverableVersionDto].self, forKey: .versions)
    }
}

struct DeliverableLimitsDto: Decodable, Equatable {
    var maxBytes: Int?
    var allowedExtensions: [String] = []
    var outputsFolder: String?

    enum CodingKeys: String, CodingKey {
        case maxBytes = "max_bytes"
        case allowedExtensions = "allowed_extensions"
        case outputsFolder = "outputs_folder"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxBytes = try? c.decodeIfPresent(Int.self, forKey: .maxBytes)
        allowedExtensions = (try? c.decodeIfPresent([String].self, forKey: .allowedExtensions)) ?? []
        outputsFolder = try? c.decodeIfPresent(String.self, forKey: .outputsFolder)
    }
}

/// `GET /api/tasks/{tid}/deliverables`.
struct DeliverableListDto: Decodable, Equatable {
    var deliverables: [DeliverableDto] = []
    var limits: DeliverableLimitsDto?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deliverables = (try? c.decodeIfPresent([DeliverableDto].self, forKey: .deliverables)) ?? []
        limits = try? c.decodeIfPresent(DeliverableLimitsDto.self, forKey: .limits)
    }

    enum CodingKeys: String, CodingKey { case deliverables, limits }
}

/// `GET …/versions/{v}/text`.
struct DeliverableTextDto: Decodable, Equatable {
    var text: String = ""
    var truncated = false

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }

    enum CodingKeys: String, CodingKey { case text, truncated }
}

/// `GET …/diff?from=&to=` — a unified diff for text kinds; binary kinds report only
/// whether the bytes changed.
struct DeliverableDiffDto: Decodable, Equatable {
    var binary = false
    var bytesChanged = false
    var diff: String?
    var added: Int?
    var removed: Int?
    var identical: Bool?
    var truncated: Bool?

    enum CodingKeys: String, CodingKey {
        case binary, diff, added, removed, identical, truncated
        case bytesChanged = "bytes_changed"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        binary = (try? c.decodeIfPresent(Bool.self, forKey: .binary)) ?? false
        bytesChanged = (try? c.decodeIfPresent(Bool.self, forKey: .bytesChanged)) ?? false
        diff = try? c.decodeIfPresent(String.self, forKey: .diff)
        added = try? c.decodeIfPresent(Int.self, forKey: .added)
        removed = try? c.decodeIfPresent(Int.self, forKey: .removed)
        identical = try? c.decodeIfPresent(Bool.self, forKey: .identical)
        truncated = try? c.decodeIfPresent(Bool.self, forKey: .truncated)
    }
}

/// `POST /api/tasks/{tid}/deliverables` — `deduplicated` when the bytes match the latest version.
struct DeliverableUploadResultDto: Decodable, Equatable {
    var deduplicated = false

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deduplicated = (try? c.decodeIfPresent(Bool.self, forKey: .deduplicated)) ?? false
    }

    enum CodingKeys: String, CodingKey { case deduplicated }
}
