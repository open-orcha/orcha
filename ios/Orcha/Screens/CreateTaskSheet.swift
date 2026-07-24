import SwiftUI

// Responsibility: Create-task form state, validation, assignment, priority, and submission.

/// Flow 11 — Create & assign a task. Field order is fixed: Title → Description →
/// DoD → Assign to → Priority → Advanced (Depends on + Park it). Create is disabled
/// until Title + DoD are non-blank; a dirty form asks before discarding. A 1:1 port
/// of the Android `CreateTaskScreen`.
struct CreateTaskSheet: View {
    @Environment(AppModel.self) var model
    @Environment(\.palette) var p
    @Environment(\.dismiss) var dismiss

    @State var title = ""
    @State var description = ""
    @State var dod = ""
    @State var assignee: String?
    @State var band: PriorityBand = .normal
    @State var advanced = false
    @State var dependsOn: Set<String> = []
    @State var parked = false
    @State var confirmDiscard = false
    @State var triedSubmit = false

    var dirty: Bool {
        !title.isBlank || !description.isBlank || !dod.isBlank
            || assignee != nil || parked || !dependsOn.isEmpty
    }

    var valid: Bool { !title.isBlank && !dod.isBlank }

    var agents: [AgentDto] {
        (model.snapshot?.agents ?? []).filter { $0.kind == "ai" && $0.terminatedAt == nil }
    }

    var openTasks: [TaskDto] {
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

    var titleField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Title")
            OrchaTextField(text: $title, prompt: "Short, plain-language ask", lines: 1...2)
            if triedSubmit && title.isBlank {
                helper("A title is required.", danger: true)
            }
        }
    }

    var descriptionField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionH(title: "Description")
            OrchaTextField(text: $description, prompt: "Context the agent will read", lines: 3...8)
            helper("Context the agent will read.")
        }
    }

    var dodField: some View {
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

    var assignSection: some View {
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

    var prioritySection: some View {
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

}
