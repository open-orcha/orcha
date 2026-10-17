import Foundation

/// `GET /api/plan-usage` — plan-limit snapshots the Embodent desktop app publishes to
/// each portal it is connected to (one per desktop host), newest first. Carries only
/// plan names, window labels / used % / reset times and today's tokens + est. cost.
struct PlanUsageListDto: Decodable, Equatable, Sendable {
    let snapshots: [PlanUsageSnapshotDto]

    init(snapshots: [PlanUsageSnapshotDto]) { self.snapshots = snapshots }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        snapshots = try c.decodeIfPresent([PlanUsageSnapshotDto].self, forKey: .snapshots) ?? []
    }

    private enum CodingKeys: String, CodingKey { case snapshots }
}

struct PlanUsageSnapshotDto: Decodable, Equatable, Sendable {
    let host: String
    let capturedAt: String?
    let updatedAt: String?
    let providers: [PlanUsageProviderDto]

    init(host: String, capturedAt: String?, updatedAt: String?, providers: [PlanUsageProviderDto]) {
        self.host = host
        self.capturedAt = capturedAt
        self.updatedAt = updatedAt
        self.providers = providers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decodeIfPresent(String.self, forKey: .host) ?? ""
        capturedAt = try c.decodeIfPresent(String.self, forKey: .capturedAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        providers = try c.decodeIfPresent([PlanUsageProviderDto].self, forKey: .providers) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case host, providers
        case capturedAt = "captured_at"
        case updatedAt = "updated_at"
    }
}

struct PlanUsageProviderDto: Decodable, Equatable, Sendable {
    /// `claude` | `codex`.
    let provider: String
    let plan: String?
    let headline: String?
    let windows: [PlanUsageWindowDto]
    let today: PlanUsageTodayDto?

    init(provider: String, plan: String?, headline: String?, windows: [PlanUsageWindowDto], today: PlanUsageTodayDto?) {
        self.provider = provider
        self.plan = plan
        self.headline = headline
        self.windows = windows
        self.today = today
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        plan = try c.decodeIfPresent(String.self, forKey: .plan)
        headline = try c.decodeIfPresent(String.self, forKey: .headline)
        windows = try c.decodeIfPresent([PlanUsageWindowDto].self, forKey: .windows) ?? []
        today = try c.decodeIfPresent(PlanUsageTodayDto.self, forKey: .today)
    }

    private enum CodingKeys: String, CodingKey { case provider, plan, headline, windows, today }
}

struct PlanUsageWindowDto: Decodable, Equatable, Sendable {
    let key: String
    let label: String
    let usedPct: Double
    let resetsAt: String?

    init(key: String, label: String, usedPct: Double, resetsAt: String?) {
        self.key = key
        self.label = label
        self.usedPct = usedPct
        self.resetsAt = resetsAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        key = try c.decodeIfPresent(String.self, forKey: .key) ?? label
        usedPct = try c.decodeIfPresent(Double.self, forKey: .usedPct) ?? 0
        resetsAt = try c.decodeIfPresent(String.self, forKey: .resetsAt)
    }

    private enum CodingKeys: String, CodingKey {
        case key, label
        case usedPct = "used_pct"
        case resetsAt = "resets_at"
    }
}

struct PlanUsageTodayDto: Decodable, Equatable, Sendable {
    let tokens: Int?
    let costUsd: Double?

    init(tokens: Int?, costUsd: Double?) {
        self.tokens = tokens
        self.costUsd = costUsd
    }

    private enum CodingKeys: String, CodingKey {
        case tokens
        case costUsd = "cost_usd"
    }
}

/// `GET|PUT /api/plan-usage/display` — the portal-wide "show plan usage" setting.
/// `updated_at` is null until someone sets it (the default: hidden, both providers).
struct PlanUsageDisplayDto: Decodable, Equatable, Sendable {
    let show: Bool
    /// `both` | `claude` | `codex`.
    let providers: String
    let updatedAt: String?

    init(show: Bool, providers: String, updatedAt: String?) {
        self.show = show
        self.providers = providers
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        show = try c.decodeIfPresent(Bool.self, forKey: .show) ?? false
        providers = try c.decodeIfPresent(String.self, forKey: .providers) ?? "both"
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case show, providers
        case updatedAt = "updated_at"
    }
}
