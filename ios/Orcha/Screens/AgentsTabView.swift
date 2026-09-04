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
                                // Collab v1: GitHub members render their real avatar.
                                AgentAvatar(alias: human.alias, human: true, githubLogin: human.githubLogin)
                                VStack(alignment: .leading) {
                                    Text(human.githubLogin ?? human.alias)
                                        .font(p.uiFont(15, .semibold))
                                        .foregroundStyle(p.text)
                                    Text(humanSubtitle(human))
                                        .font(p.uiFont(13))
                                        .foregroundStyle(p.muted)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if let role = human.memberRole {
                                    MetaTag(text: role, tint: role == "owner" ? p.violet : nil)
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

    /// Collab v1 — a mapped member reads "alias · Human authority"; the GitHub
    /// login already leads the row, so the alias only repeats when it differs.
    private func humanSubtitle(_ human: AgentDto) -> String {
        if let login = human.githubLogin, login != human.alias {
            return "\(human.alias) · Human authority"
        }
        return "Human authority"
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
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                    Text(agent.role ?? "agent")
                        .font(p.uiFont(13))
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                }
                Spacer()
                StatusPill(status: agent.status ?? "idle", domain: .agent)
            }
            if agent.status == "working", let title = agent.currentTask?.title {
                Text("▸ \(title)")
                    .font(p.uiFont(13))
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
