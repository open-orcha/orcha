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
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        Text("Who should verify “\(task.title)”? Anyone can still verify; this only routes the review.")
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                        LCard(padding: 0) {
                            row(id: nil, title: "Anyone", sub: "No assigned reviewer") {
                                Image(systemName: "person.2")
                                    .font(.footnote)
                                    .foregroundStyle(p.faint)
                                    .frame(width: 28, height: 28)
                                    .background(p.surface2, in: Circle())
                                    .accessibilityHidden(true)
                            }
                        }
                        LSection("Members", count: humans.count) {
                            LCard(padding: 0) {
                                VStack(spacing: 0) {
                                    ForEach(Array(humans.enumerated()), id: \.element.id) { index, human in
                                        if index > 0 { LDivider() }
                                        row(
                                            id: human.id,
                                            title: human.githubLogin ?? human.alias,
                                            sub: roleLabel(human)
                                        ) {
                                            LAvatar(name: human.githubLogin ?? human.alias, size: 28)
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
                        .disabled(picked == task.reviewerAgentId || model.actionInFlight)
                        .padding(.horizontal, LSpace.l)
                        .padding(.vertical, LSpace.s)
                        .background(p.surface)
                }
            }
            .navigationTitle("Reviewer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: picked)
        .onAppear { picked = task.reviewerAgentId }
    }

    private func confirm() {
        Task {
            if await model.setTaskReviewer(task.id, reviewerAgentId: picked) {
                dismiss()
            }
        }
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
        Button { withAnimation(.lQuick) { picked = id } } label: {
            HStack(spacing: LSpace.m) {
                avatar()
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(title)
                            .ltype(.bodyEmph)
                            .foregroundStyle(p.text)
                        if id == task.reviewerAgentId { LTag("Current") }
                    }
                    Text(sub)
                        .ltype(.meta)
                        .foregroundStyle(p.faint)
                }
                Spacer()
                Image(systemName: "checkmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(p.accent)
                    .opacity(picked == id ? 1 : 0)
                    .scaleEffect(picked == id ? 1 : 0.5)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, LSpace.m)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked == id ? [.isSelected] : [])
    }
}
