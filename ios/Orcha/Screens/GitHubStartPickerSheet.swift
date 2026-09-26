import SwiftUI

/// The GitHub hub's Start-with-an-agent picker — the ReviewerPickerSheet idiom, but
/// over the container's live AI agents (the hub assigns work to agents, not humans).
/// "Unassigned" parks a `ready` task Atlas can route; picking an agent assigns it and
/// fires the wake. On success it hands the started task back to the caller to navigate.
struct GitHubStartPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    let kind: GitHubHubKind
    let number: Int
    let title: String
    let bodyExcerpt: String?
    let htmlUrl: String?
    /// Called with the started task on success (the caller navigates to it).
    let onStarted: (GitHubStartResponse) -> Void

    /// nil = "Unassigned"; else the AI agent's id.
    @State private var picked: String?

    private var agents: [AgentDto] { model.githubAssignableAgents }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("START AS A TASK")
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        Text("Turn \(kind == .pulls ? "PR" : "issue") #\(number) into an Orcha task. Assign an agent to wake it now, or leave it unassigned for the backlog.")
                            .font(p.uiFont(13))
                            .foregroundStyle(p.muted)

                        row(id: nil, title: "Unassigned", sub: "Parked in the backlog") {
                            Image(systemName: "tray")
                                .font(p.uiFont(13))
                                .foregroundStyle(p.muted)
                                .frame(width: 30, height: 30)
                                .background(p.surface2, in: Circle())
                                .overlay(Circle().strokeBorder(p.border2, lineWidth: 1))
                                .accessibilityHidden(true)
                        }

                        SectionH(title: "Agents", count: "\(agents.count)")
                        if agents.isEmpty {
                            Text("No AI agents are active in this Orcha yet.")
                                .font(p.uiFont(13))
                                .foregroundStyle(p.faint)
                        }
                        ForEach(agents) { agent in
                            row(id: agent.id, title: agent.alias, sub: MobileUx.statusCopy(agent.status ?? "idle")) {
                                AgentAvatar(alias: agent.alias, size: 30)
                            }
                        }

                        KitButton(
                            title: confirmTitle,
                            role: .primary,
                            enabled: !model.actionInFlight
                        ) {
                            Task {
                                if let response = await model.startGithubItem(
                                    kind: kind, number: number,
                                    title: title, bodyExcerpt: bodyExcerpt, htmlUrl: htmlUrl,
                                    assigneeAgentId: picked
                                ) {
                                    onStarted(response)
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
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private var confirmTitle: String {
        guard let picked, let name = agents.first(where: { $0.id == picked })?.alias else {
            return "Start — unassigned"
        }
        return "Start · assign \(name)"
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
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked == id ? [.isSelected] : [])
    }
}
