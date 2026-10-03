import Foundation

/// Reporting-line tree for the Agents tab's Org view — pure, so it is unit-tested.
enum AgentOrgUx {
    struct Node: Identifiable, Equatable {
        let id: String
        let depth: Int
    }

    /// Depth-first flattening: roots (no manager, or a manager outside the set / a cycle)
    /// first in `order`, each followed by its reports, indented by `depth`.
    static func flatten(order: [String], managerOf: [String: String]) -> [Node] {
        let ids = Set(order)
        var children: [String: [String]] = [:]
        var roots: [String] = []
        for id in order {
            if let m = managerOf[id], ids.contains(m), m != id, !reachesSelf(id, managerOf) {
                children[m, default: []].append(id)
            } else {
                roots.append(id)
            }
        }
        var out: [Node] = []
        var seen = Set<String>()
        func walk(_ id: String, _ depth: Int) {
            guard seen.insert(id).inserted else { return }
            out.append(Node(id: id, depth: depth))
            for c in children[id] ?? [] { walk(c, depth + 1) }
        }
        for r in roots { walk(r, 0) }
        return out
    }

    /// Every id below `id` (its reports, their reports, …) — cycle-safe.
    static func descendants(of id: String, managerOf: [String: String]) -> Set<String> {
        var down: [String: [String]] = [:]
        for (child, manager) in managerOf { down[manager, default: []].append(child) }
        var out = Set<String>()
        var stack = down[id] ?? []
        while let c = stack.popLast() {
            guard c != id, out.insert(c).inserted else { continue }
            stack.append(contentsOf: down[c] ?? [])
        }
        return out
    }

    /// Who `agentId` may report to (web `managerCandidates`): live agents and humans in the
    /// project, never itself or one of its own reports (that would make a loop). Humans
    /// first (they receive escalations), then AI agents, each in the order given.
    static func managerCandidates(
        for agentId: String,
        people: [(id: String, isHuman: Bool, retired: Bool)],
        managerOf: [String: String]
    ) -> [String] {
        let below = descendants(of: agentId, managerOf: managerOf)
        let live = people.filter { $0.id != agentId && !$0.retired && !below.contains($0.id) }
        return live.filter(\.isHuman).map(\.id) + live.filter { !$0.isHuman }.map(\.id)
    }

    /// The success toast after a reporting-line change (web OrgPage copy).
    static func changedToast(alias: String, managerAlias: String?) -> String {
        if let managerAlias { return "\(alias) now reports to \(managerAlias)" }
        return "\(alias) has no manager"
    }

    /// The server's own reason from a FastAPI error body (`{"detail": "…"}`) — the 409
    /// loop / 422 retired-manager copy is written for people — else nil.
    static func serverDetail(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = obj["detail"] as? String,
              !detail.isEmpty else { return nil }
        return detail
    }

    /// Ids whose manager is set but is not in `live` (retired or gone) — the Org view
    /// shows them at the top level with "Manager retired — no active manager".
    static func managerGone(live: Set<String>, managerOf: [String: String]) -> Set<String> {
        Set(managerOf.compactMap { child, manager in
            live.contains(child) && !live.contains(manager) ? child : nil
        })
    }

    private static func reachesSelf(_ id: String, _ managerOf: [String: String]) -> Bool {
        var cur = managerOf[id]
        var hops = 0
        while let c = cur, hops < 64 {
            if c == id { return true }
            cur = managerOf[c]
            hops += 1
        }
        return false
    }
}
