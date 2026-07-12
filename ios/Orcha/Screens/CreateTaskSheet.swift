import SwiftUI

/// Flow 11 — Create & assign a task. Field order is fixed: Title → Description →
/// DoD → Assign to → Priority → Advanced (Depends on + Park it). Create is disabled
/// until Title + DoD are non-blank; a dirty form asks before discarding. A 1:1 port
/// of the Android `CreateTaskScreen`.
struct CreateTaskSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var description = ""
    @State private var dod = ""
    @State private var assignee: String?
    @State private var band: PriorityBand = .normal
    @State private var advanced = false
    @State private var dependsOn: Set<String> = []
    @State private var parked = false
    @State private var confirmDiscard = false
    @State private var triedSubmit = false

    private var dirty: Bool {
        !title.isBlank || !description.isBlank || !dod.isBlank
            || assignee != nil || parked || !dependsOn.isEmpty
    }

    private var valid: Bool { !title.isBlank && !dod.isBlank }

    private var agents: [AgentDto] {
        (model.snapshot?.agents ?? []).filter { $0.kind == "ai" && $0.terminatedAt == nil }
    }

    private var openTasks: [TaskDto] {
        (model.snapshot?.tasks ?? []).filter { !["completed", "cancelled"].contains($0.status) }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        titleField
                        descriptionField
                        dodField
                        assignSection
                        prioritySection
                        advancedSection
                        if let error = model.error {
                            Banner(kind: .danger, text: "Couldn't create the task — nothing was lost. \(error)")
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Create task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { requestClose() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Create") { submit() }
                        .font(.system(size: 16, weight: .heavy))
                        .disabled(!valid)
                }
            }
            .confirmationDialog(
                "Discard draft?",
                isPresented: $confirmDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard draft", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("Your task draft will be lost.")
            }
        }
    }

    // MARK: fields

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Title")
            OrchaTextField(text: $title, prompt: "Short, plain-language ask", lines: 1...2)
            if triedSubmit && title.isBlank {
                helper("A title is required.", danger: true)
            }
        }
    }

    private var descriptionField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Description")
            OrchaTextField(text: $description, prompt: "Context the agent will read", lines: 3...8)
            helper("Context the agent will read.")
        }
    }

    private var dodField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Definition of done")
            OrchaTextField(text: $dod, prompt: "How will you know it's done?", lines: 3...8)
            if triedSubmit && dod.isBlank {
                helper("Required — the agent stops at needs-verification and you check against this.", danger: true)
            } else {
                helper("How will you know it's done? The agent stops at needs-verification and you check against this.")
            }
        }
    }

    // MARK: assign to

    private var assignSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Assign to", count: assignee ?? "unassigned")
            if agents.isEmpty {
                OrchaCard {
                    Text("No agents registered yet — the task will start unassigned.")
                        .font(.system(size: 13))
                        .foregroundStyle(p.muted)
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        AssigneeChip(alias: "Unassigned", selected: assignee == nil) {
                            assignee = nil
                        }
                        ForEach(agents) { agent in
                            AssigneeChip(
                                alias: agent.alias,
                                status: agent.status,
                                selected: assignee == agent.alias
                            ) {
                                assignee = agent.alias
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: priority

    private var prioritySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Priority", count: "P\(MobileUx.priorityFor(band))")
            Picker("Priority", selection: $band) {
                Text("Low").tag(PriorityBand.low)
                Text("Normal").tag(PriorityBand.normal)
                Text("High").tag(PriorityBand.high)
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: advanced

    private var advancedSection: some View {
        DisclosureGroup(isExpanded: $advanced) {
            VStack(alignment: .leading, spacing: 12) {
                dependsOnCard
                parkCard
            }
            .padding(.top, 4)
        } label: {
            Text("ADVANCED")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(p.muted)
        }
        .tint(p.accent)
    }

    private var dependsOnCard: some View {
        OrchaCard {
            Text("Depends on").font(.system(size: 14, weight: .bold)).foregroundStyle(p.text)
            Text("This task won't become ready until these complete.")
                .font(.system(size: 13)).foregroundStyle(p.muted)
            ForEach(openTasks.prefix(12)) { task in
                Button {
                    if dependsOn.contains(task.id) {
                        dependsOn.remove(task.id)
                    } else {
                        dependsOn.insert(task.id)
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: dependsOn.contains(task.id) ? "checkmark.square.fill" : "square")
                            .foregroundStyle(dependsOn.contains(task.id) ? p.accent : p.faint)
                        Text(task.title)
                            .font(.system(size: 13))
                            .foregroundStyle(p.text)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        StatusPill(status: task.status, domain: .task)
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var parkCard: some View {
        OrchaCard {
            Toggle(isOn: $parked) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Park it").font(.system(size: 14, weight: .bold)).foregroundStyle(p.text)
                    Text("The agent won't start yet — task is created pending.")
                        .font(.system(size: 13)).foregroundStyle(p.muted)
                }
            }
            .tint(p.accent)
        }
    }

    // MARK: helpers

    private func helper(_ text: String, danger: Bool = false) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(danger ? p.danger : p.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func requestClose() {
        if dirty { confirmDiscard = true } else { dismiss() }
    }

    private func submit() {
        triedSubmit = true
        guard valid, !model.actionInFlight else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDod = dod.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            if await model.createTask(
                title: cleanTitle,
                description: cleanDescription.isEmpty ? nil : cleanDescription,
                dod: cleanDod,
                assignee: assignee,
                priority: MobileUx.priorityFor(band),
                dependsOn: Array(dependsOn),
                notReady: parked
            ) != nil {
                dismiss()
            }
        }
    }
}

/// Rounded field matching `ManualConnectSheet` — surface2 fill, hairline border,
/// vertical-growth `TextField`.
private struct OrchaTextField: View {
    @Environment(\.palette) private var p
    @Binding var text: String
    let prompt: String
    let lines: ClosedRange<Int>

    var body: some View {
        TextField("", text: $text, prompt: Text(prompt), axis: .vertical)
            .lineLimit(lines)
            .padding(12)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
    }
}

/// Assignee chip — tinted when selected. "working" agents get a hint line.
private struct AssigneeChip: View {
    @Environment(\.palette) private var p
    let alias: String
    var status: String?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            OrchaCard(
                borderColor: selected ? p.accentLine : p.border,
                container: selected ? p.accentSoft : p.surface
            ) {
                HStack(spacing: 8) {
                    AgentAvatar(alias: alias, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(alias)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(p.text)
                        if let status {
                            StatusPill(status: status, domain: .agent)
                        }
                    }
                    if status == "working" {
                        Text("working — will pick this up next")
                            .font(.system(size: 11))
                            .foregroundStyle(p.muted)
                    }
                }
            }
            .frame(minWidth: 140)
        }
        .buttonStyle(.plain)
    }
}

private extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
