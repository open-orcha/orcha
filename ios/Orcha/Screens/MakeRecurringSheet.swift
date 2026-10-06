import SwiftUI

/// "Make recurring…" (web `MakeRecurringDialog`): a routine that creates a COPY of this
/// task on a schedule. The task itself is never changed; the routine records where it
/// came from (`origin_task_id`). Presets Daily / Weekdays / Weekly + a time, on the
/// device's timezone, with the server's plain-English preview and next runs.
struct MakeRecurringSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto

    @State private var preset: TaskRoutinePreset = .weekdays
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: .now) ?? .now
    @State private var weekday = 1
    @State private var skipIfOpen = true
    @State private var preview: TaskRoutinePreviewDto?
    /// Only asked for when the task has none — a routine needs a definition of done.
    @State private var dod = ""

    private var taskHasDod: Bool {
        !(task.definitionOfDone ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var dodMissing: Bool {
        !taskHasDod && dod.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private let timezone = TimeZone.current.identifier

    private var hourMinute: (Int, Int) {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        return (parts.hour ?? 9, parts.minute ?? 0)
    }

    private var cron: String {
        TaskRoutineUx.cron(preset, hour: hourMinute.0, minute: hourMinute.1, weekday: weekday)
    }

    private var scheduleText: String {
        if let preview, preview.valid, let text = preview.scheduleText { return text }
        return TaskRoutineUx.describe(preset, hour: hourMinute.0, minute: hourMinute.1, weekday: weekday)
    }

    private var assigneeNote: String {
        let draft = TaskRoutineUx.draft(from: task, agents: model.snapshot?.agents ?? [], cron: cron, timezone: timezone, skipIfOpen: skipIfOpen)
        guard let id = draft.assigneeAgentId,
              let alias = model.snapshot?.agents.first(where: { $0.id == id })?.alias else {
            return "Each run is created unassigned."
        }
        return "Each run is assigned to \(alias)."
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                Form {
                    Section {
                        Text(task.title)
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                        Text("Creates a copy of this task on a schedule. The task itself is unchanged. \(assigneeNote)")
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                    }
                    if !taskHasDod {
                        Section("Definition of done") {
                            TextField("How a reviewer knows it's finished", text: $dod, axis: .vertical)
                                .lineLimit(2...5)
                        }
                    }
                    Section("Schedule") {
                        Picker("Repeat", selection: $preset) {
                            ForEach(TaskRoutinePreset.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        if preset == .weekly {
                            Picker("On", selection: $weekday) {
                                ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { Text(TaskRoutineUx.dayNames[$0]).tag($0) }
                            }
                        }
                        DatePicker("At", selection: $time, displayedComponents: .hourAndMinute)
                        LabeledContent("Timezone", value: timezone.replacingOccurrences(of: "_", with: " "))
                        VStack(alignment: .leading, spacing: 4) {
                            if let preview, !preview.valid, let error = preview.error {
                                Text(error).foregroundStyle(p.danger)
                            } else {
                                Text(scheduleText).foregroundStyle(p.text)
                                if let next = nextRunsText {
                                    Text("Next: \(next)").foregroundStyle(p.faint)
                                }
                            }
                        }
                        .ltype(.meta)
                        .accessibilityElement(children: .combine)
                    }
                    Section {
                        Toggle("Skip a run while the previous task is still open", isOn: $skipIfOpen)
                    } footer: {
                        Text("Each run creates a normal task as you — plan approval, verification and autonomy rules apply as usual.")
                    }
                    if let error = model.error {
                        Section { Banner(kind: .danger, text: error) }
                    }
                }
                .scrollContentBackground(.hidden)
                .background(p.surface)
            }
            .navigationTitle("Make recurring")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create routine", action: create)
                        .disabled(model.actionInFlight || preview?.valid == false || dodMissing)
                }
            }
        }
        .presentationDetents([.large])
        .task(id: cron) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            preview = await model.previewTaskRoutine(cron: cron, timezone: timezone)
        }
    }

    private var nextRunsText: String? {
        guard let preview, preview.valid, !preview.nextRuns.isEmpty else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()
        let dates = preview.nextRuns.compactMap { parser.date(from: $0) ?? fallback.date(from: $0) }
        guard !dates.isEmpty else { return nil }
        return dates
            .map { $0.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()) }
            .joined(separator: " · ")
    }

    private func create() {
        var draft = TaskRoutineUx.draft(
            from: task, agents: model.snapshot?.agents ?? [],
            cron: cron, timezone: timezone, skipIfOpen: skipIfOpen
        )
        if !taskHasDod { draft.definitionOfDone = dod.trimmingCharacters(in: .whitespacesAndNewlines) }
        Task {
            if await model.makeTaskRecurring(draft) { dismiss() }
        }
    }
}
