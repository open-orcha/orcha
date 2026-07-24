import Foundation

// Responsibility: Request grouping, filtering, sorting, status, and paging behavior.

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

}
