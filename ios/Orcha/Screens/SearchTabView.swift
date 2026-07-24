import SwiftUI

/// Global search across the workspace — tasks, agents, and requests in one
/// place (the portal's "Search agents, tasks, requests…" field, phone-shaped).
/// Lives in the tab bar's search role: on iOS 26 that's the separated
/// bottom-right glass circle (the Apple Music pattern); earlier OSes show it
/// as a fifth tab. Results deep-link into the same per-tab routes.
struct SearchTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @State private var query = ""

    private var trimmed: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if trimmed.isEmpty {
                    StateLayout(
                        title: "Search this workspace",
                        sub: "Tasks, agents, and requests — matches open the same detail screens as the tabs."
                    ) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 28))
                            .foregroundStyle(p.muted)
                    } actions: {
                        EmptyView()
                    }
                    .padding(.top, 60)
                } else {
                    results
                }
            }
            .padding(16)
        }
        .searchable(text: $query, prompt: "Search tasks, agents, requests")
    }

    @ViewBuilder
    private var results: some View {
        let snapshot = model.snapshot
        let tasks = matchTasks(snapshot?.tasks ?? [])
        let agents = matchAgents(snapshot?.agents ?? [])
        let requests = matchRequests(snapshot?.requests ?? [])

        if tasks.isEmpty && agents.isEmpty && requests.isEmpty {
            OrchaCard {
                Text("No matches for “\(trimmed)”.")
                    .foregroundStyle(p.muted)
            }
        }
        if !tasks.isEmpty {
            SectionH(title: "Tasks", count: "\(tasks.count)")
            ForEach(tasks) { task in
                NavigationLink(value: WorkspaceRoute.task(task.id)) {
                    OrchaCard {
                        HStack {
                            StatusPill(status: task.status, domain: .task)
                            Spacer()
                            MetaTag(text: "P\(task.priority ?? 100)", mono: true)
                        }
                        Text(task.title)
                            .font(p.uiFont(15, .semibold))
                            .foregroundStyle(p.text)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        if !agents.isEmpty {
            SectionH(title: "Agents", count: "\(agents.count)")
            ForEach(agents) { agent in
                NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                    OrchaCard {
                        HStack(spacing: 10) {
                            AgentAvatar(alias: agent.alias, human: agent.kind == "human", size: 30)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent.alias)
                                    .font(p.uiFont(15, .semibold))
                                    .foregroundStyle(p.text)
                                if let role = agent.role, !role.isEmpty {
                                    Text(role)
                                        .font(p.uiFont(12))
                                        .foregroundStyle(p.muted)
                                        .lineLimit(1)
                                }
                            }
                            Spacer()
                            StatusPill(status: agent.status ?? "idle", domain: .agent)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        if !requests.isEmpty {
            SectionH(title: "Requests", count: "\(requests.count)")
            ForEach(requests) { req in
                NavigationLink(value: WorkspaceRoute.request(req.id)) {
                    OrchaCard {
                        HStack {
                            StatusPill(status: req.status, domain: .request)
                            Spacer()
                            Text(MobileUx.agoLabel(req.createdAt) ?? "")
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(p.faint)
                        }
                        Text(req.payload)
                            .font(p.uiFont(14))
                            .foregroundStyle(p.text2)
                            .lineLimit(2)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // Case-insensitive contains over the fields a human would scan for.
    private func hit(_ hay: String?...) -> Bool {
        let needle = trimmed.lowercased()
        return hay.contains { ($0 ?? "").lowercased().contains(needle) }
    }

    private func matchTasks(_ tasks: [TaskDto]) -> [TaskDto] {
        tasks.filter { task in
            hit(task.title, task.description, task.status, task.ownerAlias) ||
                task.assignees.contains { $0.lowercased().contains(trimmed.lowercased()) }
        }
    }

    private func matchAgents(_ agents: [AgentDto]) -> [AgentDto] {
        agents.filter { hit($0.alias, $0.role, $0.status) }
    }

    private func matchRequests(_ requests: [RequestDto]) -> [RequestDto] {
        requests.filter { hit($0.payload, $0.requesterAlias, $0.targetAlias, $0.status) }
    }
}
