import SwiftUI

/// Push destinations inside a workspace tab's NavigationStack.
enum WorkspaceRoute: Hashable {
    case task(String)
    case thread(String)
    case request(String)
    case agent(String)
    case run(RunDto)
    case converse(String)
    /// GitHub hub — the issues/PRs list and the two detail screens (by number).
    case githubHub
    case githubPull(Int)
    case githubIssue(Int)
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
    // Dev/UI-test seam: `-orchaOpenSettings` opens Settings over the workspace on launch
    // (the toolbar menu isn't reachable from UI automation behind the glass group).
    @State private var showSettings = ProcessInfo.processInfo.arguments.contains("-orchaOpenSettings")
    @State private var showMetrics = false

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
        if #available(iOS 26, *) {
            // The Liquid Glass tab bar minimizes on scroll-down — the phone
            // equivalent of the portal's collapsible sidebar (more content,
            // chrome returns on scroll-up).
            tabs.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            tabs
        }
    }

    private var tabs: some View {
        Group {
            if #available(iOS 26, *) {
                modernTabs
            } else {
                legacyTabs
            }
        }
        .sheet(isPresented: $showCreateTask) {
            CreateTaskSheet()
        }
        .sheet(isPresented: $showSettings) {
            SettingsScreen()
        }
        .sheet(isPresented: $showMetrics) {
            MetricsScreen()
        }
        .sheet(isPresented: Bindable(model).showContainerControls) {
            ContainerControlsSheet()
        }
        .tint(p.accent)
        .sensoryFeedback(.selection, trigger: model.selectedTab)
        .task { await model.refresh() }
    }

    /// iOS 26 Tab builder: the search tab takes the system search role, which
    /// renders as the separated bottom-right glass circle (the Music pattern).
    @available(iOS 26, *)
    private var modernTabs: some View {
        @Bindable var model = model
        return TabView(selection: $model.selectedTab) {
            Tab("Home", systemImage: "house", value: WorkspaceTab.home) {
                workspaceTab(path: $model.homePath) { HomeTabView(showCreateTask: $showCreateTask, showMetrics: $showMetrics) }
            }
            .badge(needsYouCount)

            Tab("Tasks", systemImage: "circle.dashed.inset.filled", value: WorkspaceTab.tasks) {
                workspaceTab { TasksTabView(showCreateTask: $showCreateTask) }
            }

            Tab("Requests", systemImage: "tray", value: WorkspaceTab.requests) {
                workspaceTab { RequestsTabView(groups: requestGroups) }
            }
            .badge(requestGroups.badgeCount)

            Tab("Agents", systemImage: "sparkles", value: WorkspaceTab.agents) {
                workspaceTab { AgentsTabView() }
            }

            Tab(value: WorkspaceTab.search, role: .search) {
                workspaceTab { SearchTabView() }
            }
        }
    }

    private var legacyTabs: some View {
        @Bindable var model = model
        return TabView(selection: $model.selectedTab) {
            workspaceTab(path: $model.homePath) { HomeTabView(showCreateTask: $showCreateTask, showMetrics: $showMetrics) }
                .tabItem { Label("Home", systemImage: "house") }
                .badge(needsYouCount)
                .tag(WorkspaceTab.home)

            workspaceTab { TasksTabView(showCreateTask: $showCreateTask) }
                .tabItem { Label("Tasks", systemImage: "circle.dashed.inset.filled") }
                .tag(WorkspaceTab.tasks)

            workspaceTab { RequestsTabView(groups: requestGroups) }
                .tabItem { Label("Requests", systemImage: "tray") }
                .badge(requestGroups.badgeCount)
                .tag(WorkspaceTab.requests)

            workspaceTab { AgentsTabView() }
                .tabItem { Label("Agents", systemImage: "sparkles") }
                .tag(WorkspaceTab.agents)

            workspaceTab { SearchTabView() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(WorkspaceTab.search)
        }
    }

    @ViewBuilder
    private func workspaceTab(
        path: Binding<[WorkspaceRoute]>? = nil,
        @ViewBuilder content: @escaping () -> some View
    ) -> some View {
        // Home gets a bound path so notification taps can push the exact
        // task/request screen programmatically; other tabs keep local state.
        if let path {
            NavigationStack(path: path) { tabRoot(content) }
        } else {
            NavigationStack { tabRoot(content) }
        }
    }

    private func tabRoot(@ViewBuilder _ content: @escaping () -> some View) -> some View {
        OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                content()
            }
            .navigationTitle(model.selectedContainer?.displayName ?? "Embodent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // Icon-only back to the projects list; VoiceOver keeps the name.
                    Button("All projects", systemImage: "chevron.backward") { model.closeWorkspace() }
                        .labelStyle(.iconOnly)
                }
                ToolbarItem(placement: .principal) {
                    ProjectSwitcherMenu(dotColor: titleDotColor, dotState: titleDotState)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // GH #148 — the execution chip opens the Notifier/Autonomy sheet;
                    // it reads the notifier's power switch, independent of connectivity.
                    ExecutionChip(running: isRunning) {
                        model.showContainerControls = true
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Metrics & usage", systemImage: "chart.bar") { showMetrics = true }
                        Button("Settings", systemImage: "gearshape") { showSettings = true }
                        Button("All projects", systemImage: "square.grid.2x2") { model.closeWorkspace() }
                        Button("Disconnect", systemImage: "xmark.circle", role: .destructive) {
                            if let id = model.selectedContainer?.id {
                                model.forgetContainer(id)
                            }
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                }
            }
            .navigationDestination(for: WorkspaceRoute.self) { route in
                OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                    switch route {
                    case let .task(id): TaskDetailScreen(taskId: id)
                    case let .thread(id): TaskThreadScreen(taskId: id)
                    case let .request(id): RequestDetailScreen(requestId: id)
                    case let .agent(id): AgentDetailScreen(agentId: id)
                    case let .run(run): RunDetailScreen(run: run)
                    case let .converse(id): ConversationScreen(agentId: id)
                    case .githubHub: GitHubHubScreen()
                    case let .githubPull(number): GitHubPullDetailScreen(number: number)
                    case let .githubIssue(number): GitHubIssueDetailScreen(number: number)
                    }
                }
            }
    }

    /// Running = the project is active and its notifier is on (agents wake).
    private var isRunning: Bool {
        guard let container = model.snapshot?.container else { return true }
        return container.status == "active" && (container.wakesEnabled ?? true)
    }

    private var connState: String {
        (model.snapshot?.container.status ?? "active") != "active" ? "paused" : "polling"
    }

    /// Title presence dot: the toolbar ConnChip's states, dot-only.
    private var titleDotState: String {
        model.snapshot == nil ? (model.loading ? "probing" : "unreachable") : connState
    }

    private var titleDotColor: Color {
        switch titleDotState {
        case "polling", "live", "active": p.ok
        case "paused": p.warn
        case "unreachable": p.danger
        default: p.idle
        }
    }
}


/// Principal-slot project switcher: presence dot + project name + chevron; the
/// menu lists every paired project (the web sidebar's project picker).
private struct ProjectSwitcherMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let dotColor: Color
    let dotState: String

    private var name: String { model.selectedContainer?.displayName ?? "Embodent" }

    var body: some View {
        Menu {
            Section("Switch project") {
                ForEach(model.containers) { container in
                    Button {
                        if container.id != model.selectedContainer?.id {
                            model.openContainer(container.id)
                        }
                    } label: {
                        projectMenuLabel(container)
                    }
                }
            }
            Button("All projects", systemImage: "square.grid.2x2") { model.closeWorkspace() }
        } label: {
            HStack(spacing: 6) {
                // The status dot rides on the icon's corner so the switcher stays compact
                // next to a crowded toolbar (Tasks adds filter + new).
                ProjectIconView(icon: model.projectIcon(for: model.selectedContainer?.id), size: 20, tile: false)
                    .overlay(alignment: .bottomTrailing) {
                        Circle()
                            .fill(dotColor)
                            .frame(width: 7, height: 7)
                            .overlay(Circle().strokeBorder(p.bg, lineWidth: 1.5))
                            .offset(x: 2, y: 2)
                    }
                    .accessibilityHidden(true)
                Text(name)
                    .ltype(.headline)
                    .foregroundStyle(p.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .truncationMode(.tail)
                    .frame(maxWidth: 120, alignment: .leading)
                    .layoutPriority(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(p.muted)
            }
            // Leave a gap before the trailing toolbar group so the chevron never touches it.
            .padding(.trailing, LSpace.s)
            .contentShape(.rect)
        }
        .accessibilityLabel("\(name), \(dotState)")
        .accessibilityHint("Switch project")
        .accessibilityShowsLargeContentViewer()
    }

    /// Menu row: the project's icon (emoji inline, glyph as its SF Symbol); a checkmark
    /// marks the open project. Menus render only Text/Image, so the glyph tint is dropped.
    @ViewBuilder
    private func projectMenuLabel(_ container: StoredContainer) -> some View {
        let icon = model.projectIcon(for: container.id)
        let isOpen = container.id == model.selectedContainer?.id
        if isOpen {
            Label(container.displayName, systemImage: "checkmark")
        } else if case let .emoji(value) = icon {
            Text("\(value)  \(container.displayName)")
        } else {
            Label(container.displayName, systemImage: ProjectIconUx.sfSymbol(for: icon))
        }
    }
}

/// Compact execution capsule (Running / Paused) — opens the Autonomy & Notifier sheet.
private struct ExecutionChip: View {
    @Environment(\.palette) private var p
    let running: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // A crowded toolbar (Tasks adds filter + new) would truncate the label to
            // "…" — fall back to the bare status dot instead.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 5) {
                    dot
                    Text(running ? "Running" : "Paused")
                        .ltype(.micro)
                        .foregroundStyle(running ? p.text2 : p.warn)
                        .fixedSize()
                }
                dot
            }
            .padding(.horizontal, LSpace.s)
            .frame(height: 24)
            .background(running ? p.surface2 : p.warnSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(running ? p.border : p.warnLine, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .animation(.lQuick, value: running)
        .accessibilityLabel("Autonomy & Notifier")
        .accessibilityValue(running ? "Running" : "Paused")
        .accessibilityShowsLargeContentViewer()
    }

    private var dot: some View {
        Circle()
            .fill(running ? p.ok : p.warn)
            .frame(width: 6, height: 6)
    }
}

/// The shared connection banner row (flow 04 H8/H10): polling is the honest v1
/// state (SSE is the listed follow-up); paused blocks agent action.
///
/// GH #148 — `container.status` (the laptop-level lifecycle set by `/orcha-pause`) and
/// `wakes_enabled` (the in-container notifier) are two DIFFERENT states (spec §6.2); this
/// used to read only `status`, mislabeling the notifier. `status` is checked first as the
/// higher-tier state, then the notifier, each with its own banner.
struct ConnectionBanners: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let snapshot = model.snapshot {
            if snapshot.container.status != "active" {
                Banner(kind: .info, text: "This Embodent is paused or stopped on the laptop — resume it there to continue.")
            } else if !(snapshot.container.wakesEnabled ?? true) {
                Banner(kind: .warn, text: "Notifier paused — agents won't wake.", action: "Resume") {
                    model.showContainerControls = true
                }
            }
            // Healthy polling is the normal state — the toolbar ConnChip already
            // says "polling", so no standing warn banner nagging every screen.
        }
    }
}

/// The unreachable full-screen state with the design's checklist copy (flow 04 H7).
struct UnreachableState: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    var body: some View {
        StateLayout(
            title: "Can't reach this Embodent",
            sub: "\(model.selectedContainer?.baseUrl ?? "The container") didn't answer. Your work is safe — the phone just can't see it right now.",
            danger: true
        ) {
            Image(systemName: "wifi.slash")
                .font(p.uiFont(30))
                .foregroundStyle(p.danger)
        } actions: {
            VStack(spacing: 12) {
                OrchaCard {
                    Text("1  Are you online? The portal needs an internet connection.")
                    Text("2  Is the deployment up — or, self-hosting, is the computer awake with Embodent running?")
                    Text("3  Access token rotated? Update it in Settings → Containers.")
                }
                .font(p.uiFont(13))
                .foregroundStyle(p.text2)
                KitButton(title: "Try again", role: .neutral) {
                    Task { await model.refresh() }
                }
                .frame(maxWidth: 220)
            }
        }
    }
}
