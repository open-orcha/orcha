import SwiftUI

/// Flow 05 T1/T2 — Tasks list, Linear style: All / Active / Backlog / Done pills with
/// counts, an assignee lens (All / Needs me / per-agent) in the toolbar, search, and
/// collapsible status groups (terminal groups start collapsed). Rows carry the
/// priority bars, mono id, status glyph, title, chips, assignee and relative time.
struct TasksTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Binding var showCreateTask: Bool
    @State private var scope: TaskScope = .all
    @State private var filter = "All"
    @State private var query = ""
    @State private var collapsed: Set<String> = ["completed", "cancelled"]
    @State private var shown = TASKS_PAGE
    @State private var verifySheetTask: TaskDto?
    @State private var planSheetTask: TaskDto?
    @State private var reassignSheetTask: TaskDto?

    private static let TASKS_PAGE = 30

    var body: some View {
        Group {
            if model.snapshot == nil {
                if model.loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) } else { UnreachableState() }
            } else {
                content
            }
        }
        .background(p.bg)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                lensMenu
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Create task", systemImage: "plus") { showCreateTask = true }
            }
        }
        .sheet(item: $verifySheetTask) { VerifySheet(task: $0) }
        .sheet(item: $planSheetTask) { PlanApprovalSheet(task: $0) }
        .sheet(item: $reassignSheetTask) { ReassignTaskSheet(task: $0) }
    }

    // MARK: derived data

    private var allTasks: [TaskDto] { model.snapshot?.tasks ?? [] }

    private var lensed: [TaskDto] {
        let tasks = allTasks
        let scoped: [TaskDto] = switch filter {
        case "All": tasks
        case "Needs me": MobileUx.needsMe(tasks)
        default: tasks.filter { $0.assignees.contains(filter) || $0.ownerAlias == filter }
        }
        return query.isEmpty ? scoped : scoped.filter {
            $0.title.localizedCaseInsensitiveContains(query) ||
                ($0.description ?? "").localizedCaseInsensitiveContains(query) ||
                $0.id.localizedCaseInsensitiveContains(query)
        }
    }

    private var lensMenu: some View {
        let agents = model.snapshot?.agents.filter { $0.kind == "ai" } ?? []
        let needsMeCount = MobileUx.needsMe(allTasks).count
        return Menu {
            Picker("Show", selection: $filter) {
                Text("Everyone").tag("All")
                Text("Needs me · \(needsMeCount)").tag("Needs me")
                ForEach(agents.map(\.alias), id: \.self) { Text($0).tag($0) }
            }
        } label: {
            Image(systemName: filter == "All"
                  ? "line.3.horizontal.decrease.circle"
                  : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter by assignee")
        .accessibilityValue(filter == "All" ? "Everyone" : filter)
    }

    private var content: some View {
        let lensed = lensed
        let counts = Dictionary(grouping: lensed, by: { TaskScope.of($0.status) }).mapValues(\.count)
        let filtered = scope == .all ? lensed : lensed.filter { TaskScope.of($0.status) == scope }
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
        let options: [(TaskScope, String)] = TaskScope.allCases.map { s in
            let n = s == .all ? lensed.count : (counts[s] ?? 0)
            return (s, "\(s.label) \(n)")
        }

        return List {
            Group {
                ConnectionBanners()
                LSegmented(options, selection: $scope)
                    .padding(.bottom, LSpace.xs)
                if filter != "All" {
                    LensBanner(filter: filter) { filter = "All" }
                }
            }
            .listRowInsets(EdgeInsets(top: LSpace.xs, leading: LSpace.l, bottom: LSpace.xs, trailing: LSpace.l))
            .listRowSeparator(.hidden)
            .listRowBackground(p.bg)

            ForEach(groups, id: \.key) { status, rows in
                Section {
                    if !collapsed.contains(status) {
                        ForEach(rows) { task in
                            row(task)
                        }
                    }
                } header: {
                    GroupHeader(
                        status: status,
                        count: rows.count,
                        collapsed: collapsed.contains(status)
                    ) { toggle(status) }
                }
            }

            if ordered.count > visible.count {
                Button("Load more · \(visible.count) of \(ordered.count)") { shown += Self.TASKS_PAGE }
                    .buttonStyle(.plain)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .listRowSeparator(.hidden)
                    .listRowBackground(p.bg)
            }
            if filtered.isEmpty {
                LEmptyState(
                    icon: "checklist",
                    title: query.isEmpty ? "No tasks here" : "No matches",
                    message: query.isEmpty
                        ? "Nothing in this view yet. Create a task to get an agent moving."
                        : "Nothing matches “\(query)”.",
                    actionTitle: query.isEmpty ? "Create task" : nil,
                    action: query.isEmpty ? { showCreateTask = true } : nil
                )
                .listRowSeparator(.hidden)
                .listRowBackground(p.bg)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(p.bg)
        .environment(\.defaultMinListRowHeight, 1)
        .animation(.lQuick, value: collapsed)
        .animation(.lQuick, value: scope)
        .searchable(text: $query, prompt: "Search tasks")
        .onChange(of: filter) { shown = Self.TASKS_PAGE }
        .onChange(of: query) { shown = Self.TASKS_PAGE }
        .onChange(of: scope) { shown = Self.TASKS_PAGE }
        .refreshable { await model.refresh() }
    }

    private func row(_ task: TaskDto) -> some View {
        NavigationLink(value: WorkspaceRoute.task(task.id)) {
            TaskListRow(task: task, agents: model.snapshot?.agents ?? [])
        }
        .listRowInsets(EdgeInsets(top: 0, leading: LSpace.l, bottom: 0, trailing: LSpace.l))
        .listRowBackground(p.bg)
        .listRowSeparatorTint(p.border)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if task.status == "needs_verification", model.access.canWrite {
                Button("Verify", systemImage: "checkmark.circle") { verifySheetTask = task }
                    .tint(p.ok)
            }
            if isPlanWaiting(task), model.access.canWrite {
                Button("Review plan", systemImage: "doc.text.magnifyingglass") { planSheetTask = task }
                    .tint(p.accent)
            }
        }
        .swipeActions(edge: .leading) {
            if ReassignUx.canReassign(task), model.access.canWrite {
                Button("Reassign", systemImage: "person.crop.circle.badge.arrow.forward") { reassignSheetTask = task }
                    .tint(p.violet)
            }
        }
    }

    private func toggle(_ status: String) {
        if collapsed.contains(status) { collapsed.remove(status) } else { collapsed.insert(status) }
    }
}

private func isPlanWaiting(_ task: TaskDto) -> Bool {
    task.planMessage != nil && task.planDecision == nil && task.status == "in_progress"
}

/// The four top-level pills, mirroring the web Tasks page.
enum TaskScope: Hashable, CaseIterable {
    case all, active, backlog, done

    var label: String {
        switch self {
        case .all: "All"
        case .active: "Active"
        case .backlog: "Backlog"
        case .done: "Done"
        }
    }

    static func of(_ status: String) -> TaskScope {
        switch status {
        case "pending", "not_ready", "backlog": .backlog
        case "completed", "cancelled", "failed": .done
        default: .active
        }
    }
}

/// Muted caption group header — glyph, label, count, chevron. Tapping collapses.
private struct GroupHeader: View {
    @Environment(\.palette) private var p
    let status: String
    let count: Int
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: LSpace.s) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(p.faint)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                LStatusGlyph(status: status, size: 13)
                Text(MobileUx.statusCopy(status).capitalizedFirst)
                    .ltype(.meta)
                    .foregroundStyle(p.text2)
                Text("\(count)")
                    .ltype(.meta)
                    .foregroundStyle(p.faint)
                Spacer()
            }
            .frame(minHeight: 36)
            .padding(.horizontal, LSpace.l)
            .background(p.bg)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .accessibilityLabel("\(MobileUx.statusCopy(status)), \(count) \(count == 1 ? "task" : "tasks")")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint(collapsed ? "Shows the tasks" : "Hides the tasks")
    }
}

/// Inline note when the assignee lens is narrowing the list.
private struct LensBanner: View {
    @Environment(\.palette) private var p
    let filter: String
    let clear: () -> Void

    var body: some View {
        HStack(spacing: LSpace.s) {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(p.faint)
                .accessibilityHidden(true)
            Text(filter == "Needs me" ? "Showing tasks that need you" : "Showing \(filter)'s tasks")
                .ltype(.meta)
                .foregroundStyle(p.text2)
            Spacer()
            LButton("Clear", kind: .ghost, size: .small, action: clear)
        }
    }
}

/// Linear list row: priority · id · status glyph · title · chips … avatar · time.
struct TaskListRow: View {
    @Environment(\.palette) private var p
    let task: TaskDto
    var agents: [AgentDto] = []

    private var assignee: String? { task.assignees.first ?? task.ownerAlias }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            LPriorityGlyph(priority: task.priority, size: 14)
            LStatusGlyph(status: task.status, size: 15)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .ltype(.body)
                    .foregroundStyle(p.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(task.shortId)
                        .ltype(.mono)
                        .foregroundStyle(p.faint)
                    if isPlanWaiting(task) { LTag("Plan waiting", tint: p.violet) }
                    if task.status == "needs_verification" { LTag("Review", tint: p.ok) }
                    if !task.dependsOn.isEmpty { LTag("Waits on \(task.dependsOn.count)", tint: p.warn) }
                    if task.isRoot { LTag("Root") }
                }
                .lineLimit(1)
            }
            Spacer(minLength: LSpace.s)
            VStack(alignment: .trailing, spacing: 4) {
                if let assignee {
                    LAvatar(name: assignee, isAI: !MobileUx.isHumanAlias(assignee, in: agents), size: 20)
                } else {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .foregroundStyle(p.faint)
                        .accessibilityHidden(true)
                }
                Text(MobileUx.agoLabel(task.startedAt ?? task.createdAt)?.replacingOccurrences(of: " ago", with: "") ?? "")
                    .ltype(.micro)
                    .foregroundStyle(p.faint)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = [task.title, MobileUx.statusCopy(task.status)]
        if isPlanWaiting(task) { parts.append("plan waiting") }
        parts.append(assignee.map { "assigned to \($0)" } ?? "unassigned")
        if let ago = MobileUx.agoLabel(task.startedAt ?? task.createdAt) { parts.append("updated \(ago)") }
        return parts.joined(separator: ", ")
    }
}

extension TaskDto {
    /// Short, mono-friendly id like the web list ("a1b2c3").
    var shortId: String { String(id.replacingOccurrences(of: "task-", with: "").prefix(6)).lowercased() }
}

extension String {
    fileprivate var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// Shared pill chip (Requests + GitHub hub also use it) — Linear-style restyle.
struct FilterChip: View {
    @Environment(\.palette) private var p
    let label: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        LChip(label, selected: on, action: action)
    }
}
