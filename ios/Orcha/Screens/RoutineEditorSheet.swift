import SwiftUI

/// New routine / Edit routine (web `RoutineDialog`): the task template (title,
/// description, definition of done), assignee, priority, a schedule from presets or a
/// custom cron validated by the server (`POST …/routines/preview` — plain English and the
/// next runs), timezone, skip-if-open and enabled. Create → `POST …/routines`; edit →
/// `PATCH /api/routines/{rid}`.
struct RoutineEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    /// nil = create.
    let routineId: String?
    let onSaved: () async -> Void

    @State private var loaded = false
    @State private var loadError: String?
    @State private var original: RoutineReadDto?
    @State private var title = ""
    @State private var details = ""
    @State private var dod = ""
    @State private var assignee = ""
    @State private var priority = 100
    @State private var form = RoutineScheduleForm()
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: .now) ?? .now
    @State private var timezone = TimeZone.current.identifier
    @State private var enabled = true
    @State private var skipIfOpen = true
    @State private var preview: TaskRoutinePreviewDto?
    @State private var busy = false
    @State private var error: String?

    private var isEdit: Bool { routineId != nil }

    private var effectiveForm: RoutineScheduleForm {
        var f = form
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        f.hour = parts.hour ?? 9
        f.timeMinute = parts.minute ?? 0
        return f
    }

    private var cron: String { RoutineScheduleUx.toCron(effectiveForm) }
    private var invalid: Bool { preview?.valid == false || !RoutineScheduleUx.looksLikeCron(cron) }

    private var canSubmit: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !dod.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !invalid && !busy
    }

    private var agents: [AgentDto] { ReassignUx.candidates(model.snapshot?.agents ?? []) }

    private var assigneeGone: Bool {
        guard let id = original?.assigneeAgentId else { return false }
        return !agents.contains { $0.id == id }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Group {
                    if isEdit && !loaded {
                        if let loadError {
                            LEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load the routine", message: loadError, actionTitle: "Try again") {
                                Task { await load() }
                            }
                        } else {
                            ProgressView("Loading routine").frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    } else {
                        formBody
                    }
                }
                .background(p.surface)
            }
            .navigationTitle(isEdit ? "Edit routine" : "New routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(isEdit ? "Save routine" : "Create routine") { Task { await submit() } }
                            .disabled(!canSubmit)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(busy)
        .task { if isEdit { await load() } }
        .task(id: "\(cron)|\(timezone)") {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let sel = model.selectedContainer else { return }
            guard RoutineScheduleUx.looksLikeCron(cron) else { preview = nil; return }
            let result = try? await model.api.previewRoutineSchedule(sel.baseUrl, sel.id, cron: cron, timezone: timezone)
            guard !Task.isCancelled else { return }
            preview = result
        }
    }

    private var formBody: some View {
        Form {
            Section {
                TextField("Weekly dependency audit — {{date}}", text: $title)
                    .accessibilityLabel("Task title")
                TextField("What should happen each time", text: $details, axis: .vertical)
                    .lineLimit(2...6)
                    .accessibilityLabel("Description")
            } header: {
                Text("Task title")
            } footer: {
                Text("Use {{date}}, {{time}} or {{weekday}} in the title, description or definition of done — they're filled in with the run's date in the routine's timezone.")
            }
            Section("Definition of done") {
                TextField("How a reviewer knows it's finished", text: $dod, axis: .vertical)
                    .lineLimit(2...6)
                    .accessibilityLabel("Definition of done")
            }
            Section {
                Picker("Assignee", selection: $assignee) {
                    Text("Unassigned — normal assignment").tag("")
                    if assigneeGone, let id = original?.assigneeAgentId {
                        Text((original?.assigneeAlias ?? "unknown agent") + " (retired)").tag(id)
                    }
                    ForEach(agents) { agent in Text(agent.alias).tag(agent.id) }
                }
                Picker("Priority", selection: $priority) {
                    ForEach(RoutineScheduleUx.priorities, id: \.value) { Text($0.label).tag($0.value) }
                    if !RoutineScheduleUx.priorities.contains(where: { $0.value == priority }) {
                        Text("Custom (\(priority))").tag(priority)
                    }
                }
            }
            scheduleSection
            Section {
                Toggle("Skip a run while the previous task is still open", isOn: $skipIfOpen)
                Toggle("Enabled", isOn: $enabled)
            } footer: {
                Text("Each run creates a normal task as you — plan approval, verification and autonomy rules apply as usual.")
            }
            if let error {
                Section { Banner(kind: .danger, text: error) }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var scheduleSection: some View {
        Section {
            Picker("Repeat", selection: $form.preset) {
                ForEach(RoutineSchedulePreset.allCases) { Text($0.label).tag($0) }
            }
            switch form.preset {
            case .hourly:
                Stepper("At minute \(form.minute)", value: $form.minute, in: 0...59)
            case .weekly:
                Picker("On", selection: $form.weekday) {
                    ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { Text(RoutineScheduleUx.dayNames[$0]).tag($0) }
                }
            case .monthly:
                Picker("On day", selection: $form.monthDay) {
                    ForEach(1...28, id: \.self) { Text("\($0)").tag($0) }
                }
            case .custom:
                TextField("minute hour day month weekday", text: $form.cron)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Cron schedule")
            case .daily, .weekdays:
                EmptyView()
            }
            if form.preset != .hourly && form.preset != .custom {
                DatePicker("At", selection: $time, displayedComponents: .hourAndMinute)
            }
            Picker("Timezone", selection: $timezone) {
                ForEach(zones, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) }
            }
            .pickerStyle(.navigationLink)
            previewLine
        } header: {
            Text("Schedule")
        } footer: {
            if form.preset == .custom {
                Text("5 fields on the local clock: minute hour day-of-month month day-of-week. At most one run every 15 minutes.")
            }
        }
    }

    private var zones: [String] {
        let all = TimeZone.knownTimeZoneIdentifiers
        var list = all.contains("UTC") ? all : ["UTC"] + all
        if !list.contains(timezone) { list.insert(timezone, at: 0) }
        return list
    }

    @ViewBuilder
    private var previewLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !RoutineScheduleUx.looksLikeCron(cron) {
                Text("A schedule needs 5 fields: minute hour day month weekday.").foregroundStyle(p.danger)
            } else if let preview, !preview.valid {
                Text(preview.error ?? "That schedule isn't valid.").foregroundStyle(p.danger)
            } else {
                Text(preview?.scheduleText ?? RoutineScheduleUx.describe(cron, timezone: timezone))
                    .foregroundStyle(p.text)
                if let next = nextRunsText {
                    Text("Next: \(next)").foregroundStyle(p.faint)
                }
            }
        }
        .ltype(.meta)
        .accessibilityElement(children: .combine)
    }

    private var nextRunsText: String? {
        guard let preview, preview.valid, !preview.nextRuns.isEmpty else { return nil }
        let dates = preview.nextRuns.compactMap { MobileUx.parseInstant($0) }
        guard !dates.isEmpty else { return nil }
        var style = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute()
        style.timeZone = TimeZone(identifier: timezone) ?? .current
        return dates.map { $0.formatted(style) }.joined(separator: " · ")
    }

    // MARK: actions

    private func load() async {
        guard let sel = model.selectedContainer, let routineId else { return }
        do {
            let r = try await model.api.routine(sel.baseUrl, routineId)
            original = r
            title = r.title
            details = r.description ?? ""
            dod = r.definitionOfDone
            assignee = r.assigneeAgentId ?? ""
            priority = r.priority
            let f = RoutineScheduleUx.fromCron(r.cron)
            form = f
            time = Calendar.current.date(bySettingHour: f.hour, minute: f.timeMinute, second: 0, of: .now) ?? time
            timezone = r.timezone
            enabled = r.enabled
            skipIfOpen = r.skipIfOpen
            loadError = nil
            loaded = true
        } catch {
            loadError = InboxErrorText.describe(error)
        }
    }

    private func submit() async {
        guard canSubmit, let sel = model.selectedContainer else { return }
        let trimmedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = RoutineInput(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: trimmedDetails.isEmpty ? nil : details,
            definitionOfDone: dod,
            assigneeAgentId: assignee.isEmpty ? nil : assignee,
            priority: priority,
            cron: cron,
            timezone: timezone,
            enabled: enabled,
            skipIfOpen: skipIfOpen
        )
        busy = true
        defer { busy = false }
        do {
            let saved: RoutineReadDto
            if let routineId {
                saved = try await model.api.updateRoutine(sel.baseUrl, routineId, actor: model.humanId, input: input)
                model.toast = "Routine saved — \(saved.scheduleText)."
            } else {
                saved = try await model.api.createRoutine(sel.baseUrl, sel.id, actor: model.humanId, input: input)
                model.toast = "Routine created — \(saved.scheduleText)."
            }
            await onSaved()
            dismiss()
        } catch {
            self.error = "Couldn't \(isEdit ? "save" : "create") the routine — " + InboxErrorText.describe(error)
        }
    }
}
