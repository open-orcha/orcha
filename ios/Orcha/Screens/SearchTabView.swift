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
    /// Recent queries, newest first (per-device, small).
    @AppStorage("search.recents") private var recentsRaw = ""

    private var trimmed: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var recents: [String] {
        recentsRaw.split(separator: "\n").map(String.init)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: LSpace.xl) {
                LSearchField("Search tasks, agents, requests", text: $query)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Search")
                    .onSubmit(rememberQuery)
                if trimmed.isEmpty {
                    idle
                } else {
                    results
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(p.bg)
    }

    @ViewBuilder
    private var idle: some View {
        if recents.isEmpty {
            LEmptyState(
                icon: "magnifyingglass",
                title: "Search this workspace",
                message: "Tasks, agents, and requests — matches open the same detail screens as the tabs."
            )
            .padding(.top, 40)
        } else {
            LSection("Recent", count: recents.count, trailing: AnyView(
                Button("Clear") { recentsRaw = "" }
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .frame(minHeight: 44)
            )) {
                VStack(spacing: 0) {
                    ForEach(Array(recents.enumerated()), id: \.element) { index, recent in
                        Button { query = recent } label: {
                            LRow(title: recent) {
                                Image(systemName: "clock.arrow.circlepath")
                                    .foregroundStyle(p.muted)
                                    .accessibilityHidden(true)
                            } trailing: {
                                Image(systemName: "arrow.up.left")
                                    .foregroundStyle(p.faint)
                                    .accessibilityHidden(true)
                            }
                        }
                        .buttonStyle(.lRow)
                        .accessibilityHint("Search again")
                        .shellRowEntrance(index)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var results: some View {
        let snapshot = model.snapshot
        let tasks = matchTasks(snapshot?.tasks ?? [])
        let agents = matchAgents(snapshot?.agents ?? [])
        let requests = matchRequests(snapshot?.requests ?? [])

        if tasks.isEmpty && agents.isEmpty && requests.isEmpty {
            LEmptyState(
                icon: "text.magnifyingglass",
                title: "No matches",
                message: "Nothing matches “\(trimmed)”. Try a title, an agent, or a status."
            )
            .padding(.top, 24)
        }
        if !tasks.isEmpty {
            LSection("Tasks", count: tasks.count) {
                VStack(spacing: 0) {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        NavigationLink(value: WorkspaceRoute.task(task.id)) {
                            LRow(title: task.title, subtitle: MobileUx.statusCopy(task.status)) {
                                HStack(spacing: LSpace.s) {
                                    LPriorityGlyph(priority: task.priority)
                                    LStatusGlyph(status: task.status)
                                }
                            } trailing: {
                                Text(task.shortId)
                                    .ltype(.mono)
                            }
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.lRow)
                        .simultaneousGesture(TapGesture().onEnded(rememberQuery))
                        .shellRowEntrance(index)
                    }
                }
            }
        }
        if !agents.isEmpty {
            LSection("Agents", count: agents.count) {
                VStack(spacing: 0) {
                    ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                        NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                            LRow(title: agent.alias, subtitle: agent.role) {
                                LAvatar(name: agent.alias, isAI: agent.kind != "human", size: 24, status: agent.status)
                            } trailing: {
                                Text(MobileUx.statusCopy(agent.status ?? "idle"))
                            }
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.lRow)
                        .simultaneousGesture(TapGesture().onEnded(rememberQuery))
                        .shellRowEntrance(index)
                    }
                }
            }
        }
        if !requests.isEmpty {
            LSection("Requests", count: requests.count) {
                VStack(spacing: 0) {
                    ForEach(Array(requests.enumerated()), id: \.element.id) { index, req in
                        NavigationLink(value: WorkspaceRoute.request(req.id)) {
                            LRow(title: req.payload, subtitle: "\(req.requesterAlias ?? "agent") → \(req.targetAlias ?? "you")") {
                                Image(systemName: MobileUx.requestStatusGlyph(req.status, escalated: req.targetId == nil))
                                    .foregroundStyle(p.muted)
                                    .accessibilityHidden(true)
                            } trailing: {
                                Text(MobileUx.agoLabel(req.createdAt) ?? "")
                            }
                            .accessibilityElement(children: .combine)
                        }
                        .buttonStyle(.lRow)
                        .simultaneousGesture(TapGesture().onEnded(rememberQuery))
                        .shellRowEntrance(index)
                    }
                }
            }
        }
    }

    /// Pushes the current query to the front of the recents (deduped, max 6).
    private func rememberQuery() {
        let q = trimmed
        guard !q.isEmpty else { return }
        let next = [q] + recents.filter { $0.caseInsensitiveCompare(q) != .orderedSame }
        recentsRaw = next.prefix(6).joined(separator: "\n")
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
