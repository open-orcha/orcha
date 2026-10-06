import SwiftUI

enum AgentsRosterMode: Hashable {
    case roster, org
}

/// Agents tab "Org" view — the reporting lines as a simple indented tree (web `/org`
/// parity). Humans (who receive escalations) sit on top; retired agents are left out and
/// their reports surface at the top level with "Manager retired"; loops in the data can't
/// hang or hide anyone (`AgentOrgUx.flatten`). Lines are edited from an agent's detail
/// screen ("Change manager…"); a change re-reads the lines here (`OrgRevision`).
struct AgentsOrgView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agents: [AgentDto]
    let budgets: [String: AgentBudgetDto]

    @State private var managerOf: [String: String] = [:]
    @State private var loaded = false

    private var live: [AgentDto] {
        agents.filter { $0.terminatedAt == nil && $0.status != "terminated" }
    }

    private var nodes: [AgentOrgUx.Node] {
        let humans = live.filter { $0.kind == "human" }.map(\.id)
        let ai = MobileUx.orderAgents(live.filter { $0.kind != "human" }).map(\.id)
        // Humans first and pinned as roots: the chart reads top-down from the people
        // escalations reach, whatever line a human row may carry.
        let lines = managerOf.filter { child, _ in !humans.contains(child) }
        return AgentOrgUx.flatten(order: humans + ai, managerOf: lines)
    }

    private var managerGone: Set<String> {
        AgentOrgUx.managerGone(live: Set(live.map(\.id)), managerOf: managerOf)
    }

    var body: some View {
        let byId = Dictionary(agents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let gone = managerGone
        let tree = nodes
        VStack(alignment: .leading, spacing: LSpace.s) {
            if loaded && managerOf.isEmpty {
                Text("No reporting lines yet — open an agent and use Reports to → Change manager…")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 0) {
                ForEach(tree) { node in
                    if let agent = byId[node.id] {
                        if node.id != tree.first?.id { LDivider().padding(.leading, 56) }
                        row(agent, depth: node.depth, managerRetired: gone.contains(agent.id))
                    }
                }
            }
            .background(p.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1))
        }
        .task(id: "\(model.selectedContainer?.id ?? "")|\(OrgRevision.shared.value)") {
            guard let sel = model.selectedContainer,
                  let org = try? await model.api.orgLines(sel.baseUrl, sel.id) else { loaded = true; return }
            managerOf = Dictionary(org.agents.compactMap { r in r.reportsTo.map { (r.id, $0) } }, uniquingKeysWith: { a, _ in a })
            loaded = true
        }
    }

    @ViewBuilder
    private func row(_ agent: AgentDto, depth: Int, managerRetired: Bool) -> some View {
        let indent = CGFloat(min(depth, 4)) * 18
        if agent.kind == "ai" {
            NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                VStack(alignment: .leading, spacing: 0) {
                    AgentRosterRow(agent: agent, budget: budgets[agent.id])
                    if managerRetired {
                        Label("Manager retired — no active manager", systemImage: "exclamationmark.triangle")
                            .ltype(.micro)
                            .foregroundStyle(p.warn)
                            .padding(.leading, 56)
                            .padding(.bottom, LSpace.s)
                    }
                }
                .padding(.leading, indent)
            }
            .buttonStyle(.plain)
            .accessibilityHint(depth > 0 ? "Reports to \(managerAlias(agent.id) ?? "a manager")" : "")
        } else {
            HStack(spacing: LSpace.m) {
                AgentAvatar(alias: agent.alias, human: true, githubLogin: agent.githubLogin, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.githubLogin ?? agent.alias).ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                    Text(agent.memberRole?.capitalized ?? "Human authority").ltype(.meta).foregroundStyle(p.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, LSpace.m)
            .padding(.vertical, LSpace.m)
            .padding(.leading, indent)
            .frame(minHeight: 60)
            .accessibilityElement(children: .combine)
        }
    }

    private func managerAlias(_ id: String) -> String? {
        guard let m = managerOf[id] else { return nil }
        return agents.first { $0.id == m }?.alias
    }
}

/// "Paused · budget" — replaces the status capsule when the budget hard stop is on.
struct BudgetPausedCapsule: View {
    @Environment(\.palette) private var p

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "pause.fill")
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(p.danger)
            Text("Paused · budget")
                .ltype(.micro)
                .foregroundStyle(p.text)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(p.dangerSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(p.dangerLine, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
