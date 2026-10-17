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
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        // Collab v1: honest gating — a viewer / trusted non-member
                        // sees WHY Create is off (the server 403s the write anyway).
                        if let denial = model.access.writeDenialReason {
                            Banner(kind: .info, text: denial)
                        }
                        titleField
                        descriptionField
                        dodField
                        propertyChips
                        if !dependsOn.isEmpty || advanced {
                            dependsOnList
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: "Couldn't create the task — nothing was lost. \(error)")
                        }
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(p.surface)
            }
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { requestClose() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Create task") { submit() }
                        .fontWeight(.semibold)
                        .tint(p.accent)
                        .disabled(!valid || !model.access.canWrite || model.actionInFlight)
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
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(dirty)
    }

    // MARK: fields

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("", text: $title, prompt: Text("Task title").foregroundStyle(p.faint), axis: .vertical)
                .lineLimit(1...3)
                .ltype(.title)
                .foregroundStyle(p.text)
                .accessibilityLabel("Title")
            if triedSubmit && title.isBlank {
                helper("A title is required.", danger: true)
            }
        }
    }

    private var descriptionField: some View {
        TextField("", text: $description, prompt: Text("Add description… (markdown)").foregroundStyle(p.faint), axis: .vertical)
            .lineLimit(2...10)
            .ltype(.body)
            .foregroundStyle(p.text2)
            .accessibilityLabel("Description")
            .accessibilityHint("Context the agent will read. Markdown is supported.")
    }

    private var dodField: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(p.ok)
                    .accessibilityHidden(true)
                TextField("", text: $dod, prompt: Text("Done when…").foregroundStyle(p.faint), axis: .vertical)
                    .lineLimit(1...6)
                    .ltype(.body)
                    .foregroundStyle(p.text)
                    .accessibilityLabel("Done when")
            }
            .padding(LSpace.m)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1))
            if triedSubmit && dod.isBlank {
                helper("Required — the agent stops at needs verification and you check against this.", danger: true)
            } else {
                helper("The agent stops at needs verification; you check against this.")
            }
        }
    }

    // MARK: property chips (Priority · Assignee · Depends on · Park)

    private var propertyChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: LSpace.s) {
                Menu {
                    Picker("Priority", selection: $band) {
                        Text("High").tag(PriorityBand.high)
                        Text("Normal").tag(PriorityBand.normal)
                        Text("Low").tag(PriorityBand.low)
                    }
                } label: {
                    HStack(spacing: 6) {
                        LPriorityGlyph(priority: MobileUx.priorityFor(band), size: 12)
                        Text(bandLabel)
                    }
                    .chipLook(p, selected: band != .normal)
                }
                .accessibilityLabel("Priority, \(bandLabel)")

                Menu {
                    Picker("Assignee", selection: $assignee) {
                        Text("Unassigned").tag(String?.none)
                        ForEach(agents) { agent in
                            Text(agent.status == "working" ? "\(agent.alias) · working" : agent.alias)
                                .tag(Optional(agent.alias))
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if let assignee {
                            LAvatar(name: assignee, isAI: true, size: 16)
                        } else {
                            Image(systemName: "person.crop.circle.dashed")
                        }
                        Text(assignee ?? "Assignee")
                    }
                    .chipLook(p, selected: assignee != nil)
                }
                .accessibilityLabel("Assignee, \(assignee ?? "unassigned")")

                LChip(
                    dependsOn.isEmpty ? "Depends on" : "Depends on \(dependsOn.count)",
                    icon: "arrow.triangle.branch",
                    selected: !dependsOn.isEmpty || advanced
                ) {
                    withAnimation(.lQuick) { advanced.toggle() }
                }

                LChip(parked ? "Parked" : "Park it", icon: "moon.zzz", selected: parked) {
                    parked.toggle()
                }
                .accessibilityValue(parked ? "On — created pending" : "Off")
            }
            .ltype(.meta)
        }
    }

    private var bandLabel: String {
        switch band {
        case .high, .elevated: "High"
        case .normal: "Priority"
        case .low: "Low"
        }
    }

    private var dependsOnList: some View {
        LSection("Depends on", count: dependsOn.count) {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    if openTasks.isEmpty {
                        Text("No open tasks to wait on.")
                            .ltype(.meta)
                            .foregroundStyle(p.faint)
                            .padding(LSpace.m)
                    }
                    ForEach(Array(openTasks.prefix(12).enumerated()), id: \.element.id) { index, task in
                        if index > 0 { LDivider() }
                        Button { toggleDependency(task.id) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: dependsOn.contains(task.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(dependsOn.contains(task.id) ? p.accent : p.faint)
                                LStatusGlyph(status: task.status, size: 13)
                                Text(task.title)
                                    .ltype(.body)
                                    .foregroundStyle(p.text)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, LSpace.m)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(dependsOn.contains(task.id) ? .isSelected : [])
                    }
                }
            }
        }
    }

    private func toggleDependency(_ id: String) {
        if dependsOn.contains(id) { dependsOn.remove(id) } else { dependsOn.insert(id) }
    }

    // MARK: helpers

    private func helper(_ text: String, danger: Bool = false) -> some View {
        Text(text)
            .ltype(.micro)
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

private extension View {
    /// Menu-label chip matching `LChip`'s look (a Menu can't host LChip's own button).
    func chipLook(_ p: Palette, selected: Bool) -> some View {
        self
            .foregroundStyle(selected ? p.text : p.text2)
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(selected ? p.surface3 : p.surface2, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? p.border2 : p.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }
}

private extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
