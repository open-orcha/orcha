import SwiftUI

/// Push destinations inside a workspace tab's NavigationStack.
enum WorkspaceRoute: Hashable {
    case task(String)
    case thread(String)
    case request(String)
    case agent(String)
    case run(RunDto)
    case converse(String)
}

extension RunDto: Hashable {
    static func == (lhs: RunDto, rhs: RunDto) -> Bool { lhs.runId == rhs.runId }
    func hash(into hasher: inout Hasher) { hasher.combine(runId) }
}

/// Flow 04 — the container workspace: TabView (badges), per-tab NavigationStacks,
/// connection banners, needs-you queue, stat tiles, activity.
struct WorkspaceScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @State private var showCreateTask = false
    @State private var showSettings = false

    private var requestGroups: RequestGroups {
        MobileUx.requestGroups(model.snapshot?.requests ?? [], humanId: model.humanId)
    }

    private var needsYouCount: Int {
        let tasks = model.snapshot?.tasks ?? []
        let plans = tasks.filter { $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil }
        let verifs = tasks.filter { $0.status == "needs_verification" }
        let reqs = (model.snapshot?.requests ?? []).filter { $0.status == "open" && ($0.targetId == model.humanId || $0.targetId == nil) }
        return plans.count + verifs.count + reqs.count
    }

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            workspaceTab { HomeTabView(showCreateTask: $showCreateTask) }
                .tabItem { Label("Home", systemImage: "house.fill") }
                .badge(needsYouCount)
                .tag(WorkspaceTab.home)

            workspaceTab { TasksTabView(showCreateTask: $showCreateTask) }
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(WorkspaceTab.tasks)

            workspaceTab { RequestsTabView(groups: requestGroups) }
                .tabItem { Label("Requests", systemImage: "tray.full.fill") }
                .badge(requestGroups.badgeCount)
                .tag(WorkspaceTab.requests)

            workspaceTab { AgentsTabView() }
                .tabItem { Label("Agents", systemImage: "sparkles") }
                .tag(WorkspaceTab.agents)
        }
        .sheet(isPresented: $showCreateTask) {
            CreateTaskSheet()
        }
        .sheet(isPresented: $showSettings) {
            SettingsScreen()
        }
        .task { await model.refresh() }
    }

    @ViewBuilder
    private func workspaceTab(
        @ViewBuilder content: @escaping () -> some View
    ) -> some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                content()
            }
            .navigationTitle(model.selectedContainer?.displayName ?? "Orcha")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("My Orchas", systemImage: "chevron.backward") { model.closeWorkspace() }
                        .labelStyle(.titleAndIcon)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ConnChip(state: model.snapshot == nil ? (model.loading ? "probing" : "unreachable") : connState)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Settings") { showSettings = true }
                        Button("Switch container") { model.closeWorkspace() }
                        Button("Disconnect", role: .destructive) {
                            if let id = model.selectedContainer?.id {
                                model.forgetContainer(id)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .navigationDestination(for: WorkspaceRoute.self) { route in
                OrchaThemed(mode: model.themeMode) {
                    switch route {
                    case let .task(id): TaskDetailScreen(taskId: id)
                    case let .thread(id): TaskThreadScreen(taskId: id)
                    case let .request(id): RequestDetailScreen(requestId: id)
                    case let .agent(id): AgentDetailScreen(agentId: id)
                    case let .run(run): RunDetailScreen(run: run)
                    case let .converse(id): ConversationScreen(agentId: id)
                    }
                }
            }
        }
    }

    private var connState: String {
        (model.snapshot?.container.status ?? "active") != "active" ? "paused" : "polling"
    }
}

/// The shared connection banner row (flow 04 H8/H10): polling is the honest v1
/// state (SSE is the listed follow-up); paused blocks agent action.
struct ConnectionBanners: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let snapshot = model.snapshot {
            if snapshot.container.status != "active" {
                Banner(kind: .info, text: "This Orcha is paused — agents won't act until resumed from the laptop.")
            } else {
                Banner(kind: .warn, text: "Live updates unavailable — checking every 30s", action: "Refresh now") {
                    Task { await model.refresh() }
                }
            }
        }
    }
}

/// The unreachable full-screen state with the design's checklist copy (flow 04 H7).
struct UnreachableState: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    var body: some View {
        StateLayout(
            title: "Can't reach your laptop",
            sub: "\(model.selectedContainer?.baseUrl ?? "The container") didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 30))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: 12) {
                OrchaCard {
                    Text("1  Is the phone on the same Wi-Fi as the laptop?")
                    Text("2  Is the laptop awake and Orcha running?")
                    Text("3  Firewall or VPN blocking the port?")
                }
                .font(.system(size: 13))
                .foregroundStyle(p.text2)
                KitButton(title: "Try again", role: .neutral) {
                    Task { await model.refresh() }
                }
                .frame(maxWidth: 220)
            }
        }
    }
}
