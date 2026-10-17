import SwiftUI

/// Reassign a task to another AI agent (`POST /api/tasks/{tid}/assign`, `reassign: true`):
/// the current assignee is released and the new one is woken to pick it up. Only live AI
/// agents are offered — humans don't poll for work, and the server refuses them.
struct ReassignTaskSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto

    @State private var picked: String?

    private var agents: [AgentDto] { ReassignUx.candidates(model.snapshot?.agents ?? []) }
    private var currentAlias: String? { task.assignees.first ?? task.ownerAlias }
    private var currentId: String? { agents.first { $0.alias == currentAlias }?.id }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        Text("Who should work on “\(task.title)”? The current assignee is released and the new one is woken to pick it up.")
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                        if agents.isEmpty {
                            LEmptyState(
                                icon: "person.crop.circle.badge.questionmark",
                                title: "No agents to assign",
                                message: "This project has no active AI agents."
                            )
                        } else {
                            LSection("Agents", count: agents.count) {
                                LCard(padding: 0) {
                                    VStack(spacing: 0) {
                                        ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                                            if index > 0 { LDivider() }
                                            row(agent)
                                        }
                                    }
                                }
                            }
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                }
                .background(p.surface)
                .safeAreaInset(edge: .bottom) {
                    LButton(confirmTitle, kind: .primary, action: confirm)
                        .frame(maxWidth: .infinity)
                        .disabled(picked == nil || picked == currentId || model.actionInFlight)
                        .padding(.horizontal, LSpace.l)
                        .padding(.vertical, LSpace.s)
                        .background(p.surface)
                }
            }
            .navigationTitle("Reassign")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: picked)
        .onAppear { picked = currentId }
    }

    private var confirmTitle: String {
        guard let picked, picked != currentId,
              let alias = agents.first(where: { $0.id == picked })?.alias else { return "Pick an agent" }
        return "Reassign to \(alias)"
    }

    private func confirm() {
        guard let picked else { return }
        Task {
            if await model.reassignTask(task.id, to: picked) { dismiss() }
        }
    }

    private func row(_ agent: AgentDto) -> some View {
        Button { withAnimation(.lQuick) { picked = agent.id } } label: {
            HStack(spacing: LSpace.m) {
                LAvatar(name: agent.alias, isAI: true, size: 28, status: agent.status)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(agent.alias).ltype(.bodyEmph).foregroundStyle(p.text)
                        if agent.id == currentId { LTag("Current") }
                    }
                    if let role = agent.role, !role.isEmpty {
                        Text(role).ltype(.meta).foregroundStyle(p.faint).lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "checkmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(p.accent)
                    .opacity(picked == agent.id ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, LSpace.m)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked == agent.id ? [.isSelected] : [])
    }
}
