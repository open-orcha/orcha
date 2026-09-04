import SwiftUI

/// Collab v1 — assign the human reviewer on a task (owners / `assign_reviewers`
/// holders). House-style radio sheet over the snapshot's live human members;
/// "Anyone" clears the assignment. Advisory: /verify stays permissive — the
/// portal only de-emphasizes reviews that belong to someone else.
struct ReviewerPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto

    /// nil = "Anyone"; else the member's agent id.
    @State private var picked: String?

    private var humans: [AgentDto] {
        (model.snapshot?.agents ?? []).filter { $0.kind == "human" && $0.terminatedAt == nil }
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("REVIEWER")
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        Text("Who should verify “\(task.title)”? Anyone CAN still verify — this only routes the review.")
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)
                        row(id: nil, title: "Anyone", sub: "No assigned reviewer") {
                            Image(systemName: "person.2")
                                .font(p.uiFont(13))
                                .foregroundStyle(p.muted)
                                .frame(width: 30, height: 30)
                                .background(p.surface2, in: Circle())
                                .overlay(Circle().strokeBorder(p.border2, lineWidth: 1))
                                .accessibilityHidden(true)
                        }
                        SectionH(title: "Members", count: "\(humans.count)")
                        ForEach(humans) { human in
                            row(
                                id: human.id,
                                title: human.githubLogin ?? human.alias,
                                sub: roleLabel(human)
                            ) {
                                AgentAvatar(alias: human.alias, human: true, githubLogin: human.githubLogin, size: 30)
                            }
                        }
                        KitButton(
                            title: confirmTitle,
                            role: .primary,
                            enabled: picked != task.reviewerAgentId && !model.actionInFlight
                        ) {
                            Task {
                                if await model.setTaskReviewer(task.id, reviewerAgentId: picked) {
                                    dismiss()
                                }
                            }
                        }
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .onAppear { picked = task.reviewerAgentId }
    }

    private var confirmTitle: String {
        guard picked != task.reviewerAgentId else { return "Pick a reviewer" }
        guard let picked else { return "Clear — anyone verifies" }
        let name = humans.first { $0.id == picked }.map { $0.githubLogin ?? $0.alias }
        return "Assign \(name ?? "reviewer")"
    }

    private func roleLabel(_ human: AgentDto) -> String {
        var parts: [String] = []
        if let role = human.memberRole { parts.append(role.capitalized) }
        if human.githubLogin != nil, human.alias != human.githubLogin {
            parts.append(human.alias)
        }
        return parts.isEmpty ? "Human member" : parts.joined(separator: " · ")
    }

    private func row(
        id: String?, title: String, sub: String,
        @ViewBuilder avatar: () -> some View
    ) -> some View {
        Button { picked = id } label: {
            HStack(spacing: 10) {
                Image(systemName: picked == id ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(picked == id ? p.accent : p.border2)
                avatar()
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(p.uiFont(15, .semibold))
                        .foregroundStyle(p.text)
                    Text(sub)
                        .font(p.uiFont(12))
                        .foregroundStyle(p.muted)
                }
                Spacer()
                if id == task.reviewerAgentId { MetaTag(text: "current") }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked == id ? [.isSelected] : [])
    }
}
