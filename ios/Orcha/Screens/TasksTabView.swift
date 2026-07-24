import SwiftUI

/// Flow 05 T1/T2 — Tasks list: filter chips (All / Needs me / per-agent), search,
/// status groups in the binding order, terminal groups collapsed.
struct TasksTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Binding var showCreateTask: Bool
    @State private var filter = "All"
    @State private var query = ""
    @State private var showTerminals = false
    @State private var shown = TASKS_PAGE

    private static let TASKS_PAGE = 10

    var body: some View {
        Group {
            if model.snapshot == nil {
                if model.loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) } else { UnreachableState() }
            } else {
                content
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Create task", systemImage: "plus") { showCreateTask = true }
            }
        }
    }

    private var content: some View {
        let tasks = model.snapshot?.tasks ?? []
        let agents = model.snapshot?.agents.filter { $0.kind == "ai" } ?? []
        let scoped: [TaskDto] = switch filter {
        case "All": tasks
        case "Needs me": MobileUx.needsMe(tasks)
        default: tasks.filter { $0.assignees.contains(filter) || $0.ownerAlias == filter }
        }
        let filtered = query.isEmpty ? scoped : scoped.filter {
            $0.title.localizedCaseInsensitiveContains(query) ||
                ($0.description ?? "").localizedCaseInsensitiveContains(query)
        }
        // Issue 4: cap the flat status/priority-ordered list to `shown`, then group THAT slice
        // (web mechanism, tasks.html:246-250); "Load more" reveals the next page.
        let ordered = filtered.sorted { a, b in
            let ra = MobileUx.taskGroupRank(a.status), rb = MobileUx.taskGroupRank(b.status)
            if ra != rb { return ra < rb }
            let pa = a.priority ?? 100, pb = b.priority ?? 100
            if pa != pb { return pa < pb }
            return (a.createdAt ?? "") > (b.createdAt ?? "")
        }
        let visible = Array(ordered.prefix(shown))
        let groups = Dictionary(grouping: visible, by: \.status)
            .sorted { MobileUx.taskGroupRank($0.key) < MobileUx.taskGroupRank($1.key) }

        return ScrollView {
            VStack(spacing: 10) {
                ConnectionBanners()
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        let needsMeCount = MobileUx.needsMe(tasks).count
                        ForEach(["All", "Needs me"] + agents.map(\.alias), id: \.self) { chip in
                            FilterChip(
                                label: chip == "Needs me" ? "Needs me · \(needsMeCount)" : chip,
                                on: filter == chip
                            ) { filter = chip }
                        }
                    }
                }
                ForEach(groups, id: \.key) { status, rows in
                    let terminal = MobileUx.isTerminalGroup(status)
                    HStack {
                        SectionH(title: MobileUx.statusCopy(status), count: "\(rows.count)")
                        if terminal {
                            Button(showTerminals ? "hide" : "show") { showTerminals.toggle() }
                                .font(p.uiFont(11, .bold))
                                .foregroundStyle(p.accent)
                        }
                    }
                    if !terminal || showTerminals {
                        ForEach(rows) { task in
                            NavigationLink(value: WorkspaceRoute.task(task.id)) {
                                TaskRowCard(task: task)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if ordered.count > visible.count {
                    Button("Load more · \(visible.count) of \(ordered.count)") { shown += Self.TASKS_PAGE }
                        .buttonStyle(.plain)
                        .font(p.uiFont(13, .bold))
                        .foregroundStyle(p.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                if filtered.isEmpty {
                    OrchaCard {
                        Text("No tasks here yet. Create one with the plus button.")
                            .foregroundStyle(p.muted)
                    }
                }
            }
            .padding(16)
        }
        .searchable(text: $query, prompt: "Search tasks")
        .onChange(of: filter) { shown = Self.TASKS_PAGE }
        .onChange(of: query) { shown = Self.TASKS_PAGE }
        .refreshable { await model.refresh() }
    }
}

struct FilterChip: View {
    @Environment(\.palette) private var p
    let label: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(p.uiFont(13, .semibold))
                .foregroundStyle(on ? p.accent : p.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(on ? p.accentSoft : p.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(on ? p.accentLine : p.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// Flow 05 task card row: pill + title + assignee + priority band + updated-ago.
struct TaskRowCard: View {
    @Environment(\.palette) private var p
    let task: TaskDto

    var body: some View {
        OrchaCard {
            HStack(spacing: 8) {
                StatusPill(status: task.status, domain: .task)
                if task.isRoot { MetaTag(text: "root") }
                Spacer()
                let band = MobileUx.priorityBand(task.priority)
                MetaTag(
                    text: "P\(task.priority ?? 100)",
                    tint: band == .high ? p.danger : band == .elevated ? p.warn : nil
                )
            }
            Text(task.title)
                .font(p.uiFont(15, .semibold))
                .foregroundStyle(p.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                if let assignee = task.assignees.first ?? task.ownerAlias {
                    AgentAvatar(alias: assignee, size: 30)
                    Text(assignee)
                        .font(p.uiFont(13))
                        .foregroundStyle(p.text2)
                } else {
                    Text("unassigned")
                        .font(p.uiFont(13))
                        .foregroundStyle(p.faint)
                }
                if !task.dependsOn.isEmpty {
                    MetaTag(text: "waits on \(task.dependsOn.count)", tint: p.warn)
                }
                Spacer()
                Text(MobileUx.agoLabel(task.startedAt ?? task.createdAt).map { "updated \($0)" } ?? "")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.faint)
            }
        }
    }
}
