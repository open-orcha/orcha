import SwiftUI

/// Routines (web `/routines`): each routine with its schedule in words, next run and last
/// result; pause/resume, Run now and Delete; tap for recent runs. New routine / Edit open
/// `RoutineEditorSheet`. Pushed from Settings › Execution.
struct RoutinesScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var routines: [RoutineDto] = []
    @State private var lastTickAt: String?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busy: Set<String> = []
    @State private var confirm: RoutineConfirm?
    @State private var notice: String?
    @State private var editor: RoutineEditorTarget?

    private var canManage: Bool { model.access.canManage(RoutineScheduleUx.grant) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                if let notice {
                    Banner(kind: .info, text: notice)
                }
                if let actionError {
                    Banner(kind: .danger, text: actionError)
                }
                content
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .navigationDestination(for: RoutineDto.self) { routine in
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                RoutineDetailScreen(routine: routine, onChanged: { await load() })
            }
        }
        .routineConfirmation($confirm, perform: perform)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New routine", systemImage: "plus") { editor = .create }
                }
            }
        }
        .sheet(item: $editor) { target in
            RoutineEditorSheet(routineId: target.routineId, onSaved: { await load() })
        }
    }

    @ViewBuilder
    private var content: some View {
        if !loaded && loadError == nil {
            ProgressView("Loading routines")
                .frame(maxWidth: .infinity)
                .padding(.top, LSpace.xl)
        } else if let loadError {
            LEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load routines", message: loadError, actionTitle: "Try again") {
                Task { await load() }
            }
        } else if routines.isEmpty {
            LEmptyState(
                icon: "repeat",
                title: "No routines yet",
                message: "Routines create a task on a schedule. Create one here, or use “Make recurring…” on any task.",
                actionTitle: canManage ? "New routine" : nil,
                action: canManage ? { editor = .create } : nil
            )
        } else {
            if lastTickAt == nil {
                Banner(kind: .warn, text: "The scheduler hasn't checked in yet — routines fire while the Embodent notifier is running (orcha up starts it).")
            }
            section("Active", routines.filter(\.enabled))
            section("Paused", routines.filter { !$0.enabled })
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ list: [RoutineDto]) -> some View {
        if !list.isEmpty {
            LSection(title, count: list.count) {
                LCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(list) { routine in
                            RoutineRow(
                                routine: routine,
                                busy: busy.contains(routine.id),
                                onEdit: canManage ? { editor = .edit(routine.id) } : nil,
                                onToggle: { Task { await setEnabled(routine, !routine.enabled) } },
                                onRun: { confirm = .run(routine) },
                                onDelete: { confirm = .delete(routine) }
                            )
                            if routine.id != list.last?.id { LDivider(inset: LSpace.m) }
                        }
                    }
                }
            }
        }
    }

    // MARK: actions

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        do {
            let res = try await model.api.routines(sel.baseUrl, sel.id)
            routines = res.routines
            lastTickAt = res.scheduler?.lastTickAt
            loadError = nil
        } catch {
            loadError = InboxErrorText.describe(error)
        }
        loaded = true
    }

    private func setEnabled(_ routine: RoutineDto, _ enabled: Bool) async {
        guard let sel = model.selectedContainer else { return }
        busy.insert(routine.id)
        defer { busy.remove(routine.id) }
        do {
            let updated = try await model.api.setRoutineEnabled(sel.baseUrl, routine.id, actor: model.humanId, enabled: enabled)
            if let i = routines.firstIndex(where: { $0.id == routine.id }) { routines[i] = updated }
            actionError = nil
            notice = enabled ? "\(routine.displayTitle) is on." : "\(routine.displayTitle) is paused."
        } catch {
            actionError = "Couldn't \(enabled ? "enable" : "pause") the routine — " + InboxErrorText.describe(error)
        }
    }

    private func perform(_ action: RoutineConfirm) async {
        guard let sel = model.selectedContainer else { return }
        let routine = action.routine
        busy.insert(routine.id)
        defer { busy.remove(routine.id) }
        do {
            switch action {
            case .run:
                let res = try await model.api.runRoutineNow(sel.baseUrl, routine.id, actor: model.humanId)
                notice = res.outcome == "created" ? RoutineUx.runResultToast(detail: res.detail)
                    : RoutineUx.lastResult(outcome: res.outcome, taskId: res.taskId, taskStatus: nil).text + (res.detail.map { " — \($0)" } ?? "")
            case .delete:
                try await model.api.deleteRoutine(sel.baseUrl, routine.id, actor: model.humanId)
                routines.removeAll { $0.id == routine.id }
                notice = "Routine deleted. Its history and tasks are kept."
            }
            actionError = nil
            await load()
        } catch {
            let verb = if case .run = action { "run" } else { "delete" }
            actionError = "Couldn't \(verb) the routine — " + InboxErrorText.describe(error)
        }
    }
}

/// Run now / Delete both confirm first (web parity).
enum RoutineConfirm: Identifiable {
    case run(RoutineDto)
    case delete(RoutineDto)

    var routine: RoutineDto {
        switch self {
        case let .run(r), let .delete(r): r
        }
    }

    var id: String {
        switch self {
        case let .run(r): "run-" + r.id
        case let .delete(r): "delete-" + r.id
        }
    }
}

extension View {
    /// The shared Run now / Delete confirmation dialog for the routines screens.
    func routineConfirmation(_ item: Binding<RoutineConfirm?>, perform: @escaping (RoutineConfirm) async -> Void) -> some View {
        confirmationDialog(
            item.wrappedValue.map { action -> String in
                if case .run = action { return "Create a task now?" }
                return "Delete routine"
            } ?? "",
            isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: item.wrappedValue
        ) { action in
            switch action {
            case .run:
                Button("Create task") { Task { await perform(action) } }
            case .delete:
                Button("Delete routine", role: .destructive) { Task { await perform(action) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            switch action {
            case let .run(r): Text("“\(r.displayTitle)” runs once now, off its schedule.")
            case .delete: Text("It stops creating tasks. Its run history and the tasks it already created are kept.")
            }
        }
    }
}

/// One routine: title, schedule in words, next run, last result, and its actions.
private struct RoutineRow: View {
    @Environment(\.palette) private var p
    let routine: RoutineDto
    let busy: Bool
    let onEdit: (() -> Void)?
    let onToggle: () -> Void
    let onRun: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: LSpace.m) {
            NavigationLink(value: routine) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(routine.displayTitle)
                            .ltype(.bodyEmph)
                            .foregroundStyle(routine.enabled ? p.text : p.muted)
                            .multilineTextAlignment(.leading)
                        if !routine.enabled { LTag("Paused") }
                    }
                    Text(routine.scheduleText)
                        .ltype(.meta)
                        .foregroundStyle(p.text2)
                    HStack(spacing: LSpace.s) {
                        Text(RoutineUx.nextRunText(enabled: routine.enabled, nextRunAt: routine.nextRunAt))
                        Text("·").accessibilityHidden(true)
                        RoutineResultLabel(outcome: routine.lastRun?.outcome, taskId: routine.lastRun?.taskId, taskStatus: routine.lastRun?.taskStatus)
                    }
                    .ltype(.micro)
                    .foregroundStyle(p.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows recent runs")

            if busy {
                ProgressView().frame(width: 44, height: 44)
            } else {
                Menu {
                    if let onEdit {
                        Button("Edit", systemImage: "pencil", action: onEdit)
                    }
                    Button(routine.enabled ? "Pause" : "Enable", systemImage: routine.enabled ? "pause" : "play", action: onToggle)
                    Button("Run now", systemImage: "play.circle", action: onRun)
                    Button("Delete routine", systemImage: "trash", role: .destructive, action: onDelete)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(p.text2)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Actions for \(routine.displayTitle)")
            }
        }
        .padding(.leading, LSpace.m)
        .padding(.trailing, LSpace.s)
        .padding(.vertical, LSpace.s)
    }
}

/// "Done" / "Skipped" / "Failed" / "Never run" with a tone dot.
struct RoutineResultLabel: View {
    @Environment(\.palette) private var p
    let outcome: String?
    let taskId: String?
    let taskStatus: String?

    var body: some View {
        let result = RoutineUx.lastResult(outcome: outcome, taskId: taskId, taskStatus: taskStatus)
        HStack(spacing: 4) {
            if outcome != nil {
                Circle().fill(color(result.tone)).frame(width: 6, height: 6).accessibilityHidden(true)
            }
            Text(outcome == nil ? result.text : "Last run: " + result.text)
        }
    }

    private func color(_ tone: RoutineUx.Tone) -> Color {
        switch tone {
        case .ok: p.ok
        case .danger: p.danger
        case .info: p.accent
        case .neutral: p.faint
        }
    }
}

/// One routine's details and recent runs (`GET /api/routines/{rid}/runs`).
struct RoutineDetailScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @State var routine: RoutineDto
    let onChanged: () async -> Void

    @State private var runs: [RoutineRunDto] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var notice: String?
    @State private var busy = false
    @State private var confirm: RoutineConfirm?
    @State private var editing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(routine.displayTitle)
                        .ltype(.title)
                        .foregroundStyle(p.text)
                        .accessibilityAddTraits(.isHeader)
                    Text(routine.scheduleText)
                        .ltype(.body)
                        .foregroundStyle(p.text2)
                }
                if let notice { Banner(kind: .info, text: notice) }
                if let actionError { Banner(kind: .danger, text: actionError) }

                HStack(spacing: LSpace.s) {
                    LButton("Run now", icon: "play", kind: .primary, size: .small) { confirm = .run(routine) }
                    LButton(routine.enabled ? "Pause" : "Enable", icon: routine.enabled ? "pause" : "play.circle", size: .small) {
                        Task { await toggle() }
                    }
                    LButton("Delete", icon: "trash", kind: .danger, size: .small) { confirm = .delete(routine) }
                }
                .disabled(busy)

                LCard {
                    VStack(alignment: .leading, spacing: LSpace.s) {
                        fact("Next run", RoutineUx.nextRunText(enabled: routine.enabled, nextRunAt: routine.nextRunAt))
                        fact("Timezone", routine.timezone ?? "UTC")
                        fact("Assignee", routine.assigneeAlias ?? "Unassigned — normal assignment")
                        fact("If still open", routine.skipIfOpen ? "Skip the run" : "Create another task")
                    }
                }

                LSection("Recent runs", count: loaded ? runs.count : nil) {
                    runsList
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle("Routine")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await loadRuns() }
        .task { await loadRuns() }
        .routineConfirmation($confirm, perform: perform)
        .toolbar {
            if model.access.canManage(RoutineScheduleUx.grant) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editing = true }
                }
            }
        }
        .sheet(isPresented: $editing) {
            RoutineEditorSheet(routineId: routine.id, onSaved: { await reloadRoutine() })
        }
    }

    /// After an edit: the list row (schedule words, next run) comes back from the list read.
    private func reloadRoutine() async {
        await onChanged()
        guard let sel = model.selectedContainer,
              let fresh = try? await model.api.routines(sel.baseUrl, sel.id).routines.first(where: { $0.id == routine.id })
        else { return }
        routine = fresh
    }

    @ViewBuilder
    private var runsList: some View {
        if !loaded {
            ProgressView().frame(maxWidth: .infinity)
        } else if let loadError {
            Text(loadError).ltype(.meta).foregroundStyle(p.danger)
        } else if runs.isEmpty {
            Text("Never run").ltype(.meta).foregroundStyle(p.muted)
        } else {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(runs) { run in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(RoutineUx.triggerWord(trigger: run.trigger, missedCount: run.missedCount, actorAlias: run.actorAlias))
                                    .ltype(.bodyEmph)
                                    .foregroundStyle(p.text)
                                Spacer()
                                Text(MobileUx.agoLabel(run.createdAt) ?? "")
                                    .ltype(.micro)
                                    .foregroundStyle(p.faint)
                            }
                            RoutineResultLabel(outcome: run.outcome, taskId: run.taskId, taskStatus: run.taskStatus)
                                .ltype(.meta)
                                .foregroundStyle(p.text2)
                            if let title = run.taskTitle, !title.isEmpty {
                                Text(title).ltype(.meta).foregroundStyle(p.muted).lineLimit(2)
                            }
                            if let detail = run.detail, !detail.isEmpty, run.outcome != "created" {
                                Text(detail).ltype(.micro).foregroundStyle(p.muted)
                            }
                        }
                        .padding(LSpace.m)
                        .accessibilityElement(children: .combine)
                        if run.id != runs.last?.id { LDivider(inset: LSpace.m) }
                    }
                }
            }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).ltype(.meta).foregroundStyle(p.muted).frame(width: 96, alignment: .leading)
            Text(value).ltype(.meta).foregroundStyle(p.text)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func loadRuns() async {
        guard let sel = model.selectedContainer else { return }
        do {
            runs = try await model.api.routineRuns(sel.baseUrl, routine.id).runs
            loadError = nil
        } catch {
            loadError = "Couldn't load runs — " + InboxErrorText.describe(error)
        }
        loaded = true
    }

    private func toggle() async {
        guard let sel = model.selectedContainer else { return }
        busy = true
        defer { busy = false }
        do {
            routine = try await model.api.setRoutineEnabled(sel.baseUrl, routine.id, actor: model.humanId, enabled: !routine.enabled)
            notice = routine.enabled ? "Routine is on." : "Routine is paused."
            actionError = nil
            await onChanged()
        } catch {
            actionError = "Couldn't change the routine — " + InboxErrorText.describe(error)
        }
    }

    private func perform(_ action: RoutineConfirm) async {
        guard let sel = model.selectedContainer else { return }
        busy = true
        defer { busy = false }
        do {
            switch action {
            case .run:
                let res = try await model.api.runRoutineNow(sel.baseUrl, routine.id, actor: model.humanId)
                notice = res.outcome == "created" ? RoutineUx.runResultToast(detail: res.detail)
                    : RoutineUx.lastResult(outcome: res.outcome, taskId: res.taskId, taskStatus: nil).text + (res.detail.map { " — \($0)" } ?? "")
                actionError = nil
                await loadRuns()
                await onChanged()
            case .delete:
                try await model.api.deleteRoutine(sel.baseUrl, routine.id, actor: model.humanId)
                await onChanged()
                dismiss()
            }
        } catch {
            actionError = "Couldn't \(action.id.hasPrefix("run") ? "run" : "delete") the routine — " + InboxErrorText.describe(error)
        }
    }
}

/// Which routine editor to present.
enum RoutineEditorTarget: Identifiable, Hashable {
    case create
    case edit(String)

    var id: String {
        switch self {
        case .create: "create"
        case let .edit(rid): rid
        }
    }

    var routineId: String? {
        if case let .edit(rid) = self { return rid }
        return nil
    }
}
