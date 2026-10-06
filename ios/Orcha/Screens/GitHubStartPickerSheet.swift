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
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(kind == .pulls ? "PR" : "Issue") #\(number)")
                                .ltype(.mono)
                                .foregroundStyle(p.faint)
                            Text(title)
                                .ltype(.headline)
                                .foregroundStyle(p.text)
                                .lineLimit(2)
                            Text("Turn it into a Embodent task. Assign an agent to wake it now, or leave it unassigned for the backlog.")
                                .ltype(.meta)
                                .foregroundStyle(p.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        LCard(padding: 0) {
                            row(id: nil, title: "Unassigned", sub: "Parked in the backlog") {
                                Image(systemName: "tray")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(p.muted)
                                    .frame(width: 26, height: 26)
                                    .background(p.surface2, in: Circle())
                                    .overlay(Circle().strokeBorder(p.border2, lineWidth: 1))
                                    .accessibilityHidden(true)
                            }
                        }

                        LSection("Agents", count: agents.count) {
                            if agents.isEmpty {
                                LCard {
                                    Text("No AI agents are active in this Embodent yet.")
                                        .ltype(.meta)
                                        .foregroundStyle(p.faint)
                                }
                            } else {
                                LCard(padding: 0) {
                                    VStack(spacing: 0) {
                                        ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                                            if index > 0 { LDivider() }
                                            row(id: agent.id, title: agent.alias, sub: MobileUx.statusCopy(agent.status ?? "idle")) {
                                                LAvatar(name: agent.alias, isAI: true, size: 26, status: agent.status)
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        LButton(confirmTitle, icon: "play.fill", kind: .primary) {
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
                        .disabled(model.actionInFlight)
                        .frame(maxWidth: .infinity)
                        if let error = model.error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(LSpace.l)
                }
                .background(p.bg)
            }
            .navigationTitle("Start task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(p.bg)
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
            LRow(title: title, subtitle: sub) {
                avatar()
            } trailing: {
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(p.accent)
                    .opacity(picked == id ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .background(picked == id ? p.lSelected : .clear)
        }
        .buttonStyle(.lRow)
        .accessibilityAddTraits(picked == id ? [.isSelected] : [])
    }
}
