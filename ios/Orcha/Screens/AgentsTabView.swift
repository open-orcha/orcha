import SwiftUI

/// Flow 09 A1 — Agents roster: AI agents in status order + a humans section.
struct AgentsTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    var body: some View {
        Group {
            if model.snapshot == nil {
                if model.loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) } else { UnreachableState() }
            } else {
                content
            }
        }
    }

    private var content: some View {
        let agents = model.snapshot?.agents ?? []
        let ai = MobileUx.orderAgents(agents.filter { $0.kind == "ai" })
        let humans = agents.filter { $0.kind == "human" }

        return ScrollView {
            VStack(spacing: 10) {
                ConnectionBanners()
                SectionH(title: "Agents", count: "\(ai.count)")
                ForEach(ai) { agent in
                    NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                        AgentRowCard(agent: agent)
                    }
                    .buttonStyle(.plain)
                }
                if !humans.isEmpty {
                    SectionH(title: "Humans", count: "\(humans.count)")
                    ForEach(humans) { human in
                        OrchaCard {
                            HStack(spacing: 10) {
                                AgentAvatar(alias: human.alias, human: true)
                                VStack(alignment: .leading) {
                                    Text(human.alias)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(p.text)
                                    Text("Human authority")
                                        .font(.system(size: 13))
                                        .foregroundStyle(p.muted)
                                }
                            }
                        }
                    }
                }
                if ai.isEmpty && humans.isEmpty {
                    OrchaCard {
                        Text("No agents yet — create agents from the portal's onboarding.")
                            .foregroundStyle(p.muted)
                    }
                }
            }
            .padding(16)
        }
        .refreshable { await model.refresh() }
    }
}

private struct AgentRowCard: View {
    @Environment(\.palette) private var p
    let agent: AgentDto

    var body: some View {
        let dead = agent.status == "terminated" || agent.terminatedAt != nil
        OrchaCard {
            HStack(spacing: 10) {
                AgentAvatar(alias: agent.alias)
                VStack(alignment: .leading) {
                    Text(agent.alias)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text)
                    Text(agent.role ?? "agent")
                        .font(.system(size: 13))
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                }
                Spacer()
                StatusPill(status: agent.status ?? "idle", domain: .agent)
            }
            if agent.status == "working", let title = agent.currentTask?.title {
                Text("▸ \(title)")
                    .font(.system(size: 13))
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
            HStack(spacing: 8) {
                if let model = agent.model { MetaTag(text: model, mono: true) }
                Spacer()
                Text(MobileUx.agoLabel(agent.lastActive) ?? "")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(p.faint)
            }
        }
        .opacity(dead ? 0.55 : 1)
    }
}
