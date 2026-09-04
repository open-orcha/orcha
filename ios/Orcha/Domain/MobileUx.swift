import Foundation

/// Priority bands (flow 11 + flow 05): Low/Normal/High ↔ 300/100/20.
enum PriorityBand {
    case low, normal, elevated, high
}

/// Flow 07 expiry chip: warn countdown under 2h; expired past `expires_at` (row dims).
enum ExpiryChip: Equatable {
    case warn(String)
    case expired
}

/// The four request groups of flow 07 — a BINDING matrix from the design package.
struct RequestGroups {
    let needsYourAnswer: [RequestDto]
    let waitingOnOthers: [RequestDto]
    let answeredActOnIt: [RequestDto]
    let done: [RequestDto]

    /// Requests-tab badge = things the human can act on right now.
    var badgeCount: Int { needsYourAnswer.count + answeredActOnIt.count }
}

/// Pure UX selectors specified by the mobile design package — copy/ordering CONTRACTS,
/// identical to the Android `MobileUx` implementation and unit-tested against the docs.
enum MobileUx {

    // MARK: flow 07 — request grouping

    static func requestGroups(_ requests: [RequestDto], humanId: String?) -> RequestGroups {
        let doneStates: Set<String> = ["closed", "rejected", "converted_to_task"]
        func expiryKey(_ r: RequestDto) -> String { r.expiresAt ?? "9999" }
        func created(_ r: RequestDto) -> String { r.createdAt ?? "" }
        func closedOrCreated(_ r: RequestDto) -> String { r.closedAt ?? r.createdAt ?? "" }
        func byExpirySoonestThenOldest(_ a: RequestDto, _ b: RequestDto) -> Bool {
            let ea = expiryKey(a)
            let eb = expiryKey(b)
            if ea != eb { return ea < eb }
            return created(a) < created(b)
        }
        func byExpirySoonestThenNewest(_ a: RequestDto, _ b: RequestDto) -> Bool {
            let ea = expiryKey(a)
            let eb = expiryKey(b)
            if ea != eb { return ea < eb }
            return created(a) > created(b)
        }
        let needs = requests
            .filter { $0.status == "open" && ($0.targetId == humanId || $0.targetId == nil) }
            .sorted(by: byExpirySoonestThenOldest)
        let waiting = requests
            .filter { ($0.status == "open" || $0.status == "accepted") && $0.requesterId == humanId }
            .sorted(by: byExpirySoonestThenNewest)
        let answered = requests
            .filter { $0.status == "answered" && $0.requesterId == humanId }
            .sorted { created($0) > created($1) }
        let done = requests
            .filter { doneStates.contains($0.status) && ($0.requesterId == humanId || $0.targetId == humanId) }
            .sorted { closedOrCreated($0) > closedOrCreated($1) }
        return RequestGroups(needsYourAnswer: needs, waitingOnOthers: waiting, answeredActOnIt: answered, done: done)
    }

    // MARK: Issue 1 — web-parity request filtering / sorting / alias resolution

    /// The requests screen lens. `.yours` is the flow-07 grouped landing (needs-you-first,
    /// the four `requestGroups` groups); the other five mirror the web's client-side chips
    /// (`requests.html:88-99`) over the full snapshot, surfacing agent↔agent traffic too.
    enum RequestLens: String, CaseIterable, Identifiable {
        case yours, all, open, answered, escalated, task
        var id: String { rawValue }
        var label: String {
            switch self {
            case .yours: "Yours"
            case .all: "All"
            case .open: "Open"
            case .answered: "Answered"
            case .escalated: "Escalations"
            case .task: "Task reqs"
            }
        }
    }

    /// Sort control keys (web `sortComparator`, `app.js:1632-1648`). Default: time desc.
    enum RequestSortKey: String { case time, priority }

    /// Resolve an agent id → alias from the snapshot roster (web `aliasFor`, `app.js:237`).
    /// The snapshot never ships `requester_alias`/`target_alias`, so every "?" avatar is
    /// resolved here client-side instead.
    static func aliasFor(_ id: String?, in agents: [AgentDto]) -> String? {
        guard let id else { return nil }
        return agents.first { $0.id == id }?.alias
    }

    // MARK: collab v1 — GitHub identity display

    /// GitHub serves any user's avatar at this well-known URL — no API call needed
    /// (web `ghAvatar` parity). Nil for a missing/blank login; the login is
    /// percent-encoded to a strict alphanumeric+dash set (the GitHub username
    /// alphabet) so a hostile value can't smuggle path segments.
    static func githubAvatarURL(_ login: String?, sizePx: Int = 96) -> URL? {
        guard let login = login?.trimmingCharacters(in: .whitespaces), !login.isEmpty else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-")
        guard let encoded = login.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "https://github.com/\(encoded).png?size=\(sizePx)")
    }

    /// The GitHub login behind an alias — ONLY when the alias resolves to a human
    /// member (an AI agent never renders a GitHub face, whatever its alias).
    static func humanLogin(alias: String?, in agents: [AgentDto]) -> String? {
        guard let alias, let agent = agents.first(where: { $0.alias == alias }) else { return nil }
        return agent.kind == "human" ? agent.githubLogin : nil
    }

    /// Whether an alias resolves to a human member (drives the round-avatar form
    /// even for humans without a mapped GitHub login).
    static func isHumanAlias(_ alias: String?, in agents: [AgentDto]) -> Bool {
        guard let alias else { return false }
        return agents.first { $0.alias == alias }?.kind == "human"
    }

    /// Collab v1 — the needs-you de-emphasis rule, EXACTLY the web's
    /// (`home-state.js` renderQueue): a task with an owner-assigned reviewer is
    /// SOMEONE's review. The assigned reviewer, any owner, or an anonymous viewer
    /// (trust off — no identity resolved) sees the card normally; everyone else
    /// gets it de-emphasized with a "review: <login>" tag. Returns the tag's
    /// display name, or nil when the card renders normally.
    static func reviewTag(for task: TaskDto, identity: ActingIdentity?) -> String? {
        guard let reviewer = task.reviewer, let identity else { return nil }
        guard identity.agentId != reviewer.agentId, identity.memberRole != "owner" else { return nil }
        return reviewer.githubLogin ?? reviewer.alias ?? "someone"
    }

    /// Web `isToHuman` (`app.js:247-256`): a request is "to the human" when it has no
    /// explicit target (routed to the picked human) OR its target resolves to a human agent.
    /// NO status filter — mirrors the Escalations chip exactly.
    static func isToHuman(_ r: RequestDto, agents: [AgentDto]) -> Bool {
        guard let tid = r.targetId else { return true }
        guard let t = agents.first(where: { $0.id == tid }) else { return false }
        return t.kind == "human"
    }

    /// Client-side chip filter over the full snapshot (web `matches`, `requests.html:93-99`).
    static func filterRequests(_ requests: [RequestDto], lens: RequestLens, agents: [AgentDto]) -> [RequestDto] {
        requests.filter { r in
            switch lens {
            case .yours, .all: true
            case .open: r.status == "open"
            case .answered: r.status == "answered"
            case .escalated: isToHuman(r, agents: agents)
            case .task: r.type == "task"
            }
        }
    }

    /// Web `sortComparator` (`app.js:1632-1648`): the status bucket (open → answered → rest)
    /// stays the OUTER key; the chosen key sorts within it; the unchosen key is the tiebreak.
    /// Priority ascending = higher priority (lower number) first, matching the web.
    static func sortRequests(_ requests: [RequestDto], key: RequestSortKey, ascending: Bool) -> [RequestDto] {
        func bucket(_ r: RequestDto) -> Int {
            switch r.status { case "open": 0; case "answered": 1; default: 2 }
        }
        func time(_ r: RequestDto) -> Double { parseInstant(r.createdAt)?.timeIntervalSince1970 ?? 0 }
        func prio(_ r: RequestDto) -> Int { r.priority ?? 100 }
        let sign: Double = ascending ? 1 : -1
        return requests.sorted { a, b in
            let bk = bucket(a) - bucket(b)
            if bk != 0 { return bk < 0 }
            if key == .priority {
                let d = prio(a) - prio(b)
                if d != 0 { return Double(d) * sign < 0 }
                return time(a) > time(b)          // tiebreak: newest first
            }
            let d = time(a) - time(b)
            if d != 0 { return d * sign < 0 }
            return prio(a) < prio(b)              // tiebreak: highest priority first
        }
    }

    /// The status glyph shown on a request row (mobile adaptation of the web text pill).
    /// `escalated` is the STRICTER open + human-targeted rule (web `requests.html:135`),
    /// distinct from the broader Escalations *chip* which has no status filter.
    static func requestStatusGlyph(_ status: String, escalated: Bool) -> String {
        if escalated { return "xmark.octagon.fill" }
        switch status {
        case "open": return "exclamationmark.triangle.fill"
        case "accepted": return "play.fill"
        case "answered": return "checkmark.circle.fill"
        case "rejected": return "xmark.circle.fill"
        case "converted_to_task": return "arrow.right.circle.fill"
        case "closed": return "circle.fill"
        default: return "circle.fill"
        }
    }

    // MARK: Issue 4 — pure paging reducers (unit-tested; keyset prepend + seq append/dedup)

    /// Prepend an older keyset page (returned ASC) ahead of the existing thread, dropping any
    /// row already present at the page seam (dedup by message id). "Load earlier" appends the
    /// older page at the TOP without disturbing order.
    static func prependMessages(_ older: [TaskMessageDto], before existing: [TaskMessageDto]) -> [TaskMessageDto] {
        let have = Set(existing.compactMap { $0.messageId })
        let fresh = older.filter { m in m.messageId.map { !have.contains($0) } ?? true }
        return fresh + existing
    }

    /// Append an `after_seq` turns delta, dropping any seq already held (monotonic dedup).
    static func appendTurns(_ existing: [TurnDto], delta: [TurnDto]) -> [TurnDto] {
        let have = Set(existing.map { $0.seq })
        return existing + delta.filter { !have.contains($0.seq) }
    }

    // MARK: flows 11 + 05 — priority

    static func priorityBand(_ priority: Int?) -> PriorityBand {
        guard let priority else { return .normal }
        if priority <= 20 { return .high }
        if priority <= 40 { return .elevated }
        return .normal
    }

    static func priorityFor(_ band: PriorityBand) -> Int {
        switch band {
        case .high: 20
        case .elevated: 40
        case .normal: 100
        case .low: 300
        }
    }

    // MARK: flow 09 — roster order (working first, terminated last)

    static func orderAgents(_ agents: [AgentDto]) -> [AgentDto] {
        func rank(_ status: String?) -> Int {
            switch status {
            case "working": 0
            case "awaiting_human": 1
            case "blocked": 2
            case "awaiting_request": 3
            case "idle": 4
            case "terminated": 9
            default: 5
            }
        }
        return agents.enumerated()
            .sorted { (rank($0.element.status), $0.offset) < (rank($1.element.status), $1.offset) }
            .map(\.element)
    }

    // MARK: doc 12 — binding status display copy

    static func statusCopy(_ status: String) -> String {
        switch status {
        case "needs_verification": "needs verification"
        case "converted_to_task": "became a task"
        case "awaiting_request": "waiting on a request"
        case "awaiting_human": "waiting on you"
        case "in_progress": "in progress"
        default: status.replacingOccurrences(of: "_", with: " ")
        }
    }

    // MARK: GH #148 — the autonomy gearbox (`plan` | `pr` | `full`)

    static func autonomyLabel(_ level: String) -> String {
        switch level {
        case "pr": "Build to PR"
        case "full": "Full"
        default: "Plan-only"
        }
    }

    static func autonomyBlurb(_ level: String) -> String {
        switch level {
        case "pr": "Agents execute approved plans up to an open PR; you still merge."
        case "full": "Agents may carry approved work to its terminal state without further gates."
        default: "Agents wake & propose, but every plan stops at the approval gate — you approve before any execution."
        }
    }

    // MARK: flow 05 — "Needs me" + status group order

    static func needsMe(_ tasks: [TaskDto]) -> [TaskDto] {
        tasks.filter {
            $0.status == "needs_verification" ||
                ($0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil)
        }
    }

    static func taskGroupRank(_ status: String) -> Int {
        switch status {
        case "in_progress": 0
        case "blocked": 1
        case "needs_verification": 2
        case "ready": 3
        case "pending": 4
        case "not_ready": 5
        case "completed": 6
        case "cancelled": 7
        default: 8
        }
    }

    static func isTerminalGroup(_ status: String) -> Bool {
        status == "completed" || status == "cancelled"
    }

    // MARK: shared — compact relative time + expiry + day dividers

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNoFraction = ISO8601DateFormatter()

    static func parseInstant(_ iso: String?) -> Date? {
        guard var iso, !iso.isEmpty else { return nil }
        if !iso.hasSuffix("Z") && !iso.contains("+") { iso += "Z" }
        return isoParser.date(from: iso) ?? isoParserNoFraction.date(from: iso)
    }

    static func agoLabel(_ iso: String?, now: Date = Date()) -> String? {
        guard let then = parseInstant(iso) else { return nil }
        let mins = Int(now.timeIntervalSince(then) / 60)
        switch mins {
        case ..<1: return "just now"
        case ..<60: return "\(mins)m ago"
        case ..<(60 * 24): return "\(mins / 60)h ago"
        default: return "\(mins / (60 * 24))d ago"
        }
    }

    static func expiryChip(_ expiresAt: String?, now: Date = Date()) -> ExpiryChip? {
        guard let then = parseInstant(expiresAt) else { return nil }
        let deltaMin = Int(then.timeIntervalSince(now) / 60)
        if deltaMin < 0 { return .expired }
        if deltaMin >= 120 { return nil }
        if deltaMin >= 60 { return .warn("expires in \(deltaMin / 60)h \(deltaMin % 60)m") }
        return .warn("expires in \(deltaMin)m")
    }

    static func dayKey(_ iso: String?) -> String? {
        guard let iso, iso.count >= 10 else { return nil }
        let key = String(iso.prefix(10))
        return key.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? key : nil
    }

    static func dayLabel(_ iso: String?) -> String? {
        guard let key = dayKey(iso) else { return nil }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        guard (1...12).contains(parts[1]) else { return nil }
        return "\(months[parts[1] - 1]) \(parts[2])"
    }

    // MARK: GH #140 — bare task-id links in request/conversation/thread message bodies
    //
    // The backend emits NO markdown/scheme for task references — confirmed against the web
    // portal's own convention (ISS-82/GH #223, `orcha-cli/.../static/app.js` `taskRefs`):
    // a message body simply carries a raw task id (full UUID or a short hex prefix, however
    // an author happened to type it), and the CLIENT resolves it against the known task list.
    // Exact full-id match wins; else a UNIQUE 8+ hex-char prefix; ambiguous/absent → nil
    // (never guessed) — same rule as the web's `taskByRef`.
    private static let taskRefPattern = try! NSRegularExpression(
        pattern: #"\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?\b"#
    )

    static func resolveTaskRef(_ token: String, in tasks: [TaskDto]) -> TaskDto? {
        let tok = token.lowercased()
        if let exact = tasks.first(where: { $0.id.lowercased() == tok }) { return exact }
        guard tok.count >= 8, tok.count < 36 else { return nil }
        var hit: TaskDto?
        for t in tasks where t.id.lowercased().hasPrefix(tok) {
            if hit != nil { return nil }
            hit = t
        }
        return hit
    }

    /// `orcha-task:///<id>` is an in-app-only marker — never sent over the wire — used to
    /// carry a resolved task id through `AttributedString.link`/`Text` to an `openURL` handler.
    static func taskLinkURL(_ taskId: String) -> URL? {
        URL(string: "orcha-task:///\(taskId)")
    }

    static func taskIdFromLinkURL(_ url: URL) -> String? {
        guard url.scheme == "orcha-task" else { return nil }
        let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return id.isEmpty ? nil : id
    }

    /// Rewrites bare task-id tokens in `body` that resolve to a real task into `.link`-tagged
    /// runs (see `taskLinkURL`); every other token passes through as plain text.
    static func linkifyTaskRefs(_ body: String, tasks: [TaskDto]) -> AttributedString {
        guard !tasks.isEmpty else { return AttributedString(body) }
        let ns = body as NSString
        let matches = taskRefPattern.matches(in: body, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return AttributedString(body) }
        var result = AttributedString()
        var last = 0
        for m in matches {
            if m.range.location > last {
                result += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            }
            let token = ns.substring(with: m.range)
            if let task = resolveTaskRef(token, in: tasks), let url = taskLinkURL(task.id) {
                var run = AttributedString(token)
                run.link = url
                result += run
            } else {
                result += AttributedString(token)
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            result += AttributedString(ns.substring(from: last))
        }
        return result
    }
}
