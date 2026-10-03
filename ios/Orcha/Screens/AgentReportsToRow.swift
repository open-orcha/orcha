import SwiftUI

/// Agent detail "Reports to" row (org chart parity): the direct manager, tappable, plus
/// the chain above them — or "Top of the org chart" when nobody is above. Owners and
/// `manage_agents` holders get "Change manager…" (web Org panel's Reports to picker).
/// Hidden only on an older server without reporting lines.
struct AgentReportsToRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    var alias: String = "This agent"
    /// Retired agents' lines can't change (server 409) — no edit affordance.
    var retired = false

    @State private var line: ReportsToDto?
    @State private var editing = false

    private var canEdit: Bool {
        !retired && model.humanId != nil && model.access.canManage(Grant.manageAgents)
    }

    var body: some View {
        // A stack, not a Group: an empty Group renders nothing, so `.task` would never
        // fire and the row could never load itself.
        VStack(alignment: .leading, spacing: LSpace.s) {
            if let line {
                if let managerId = line.reportsToAgentId {
                    NavigationLink(value: WorkspaceRoute.agent(managerId)) {
                        card(title: "Reports to \(line.reportsToAlias ?? "a manager")", sub: chainText(line), chevron: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens \(line.reportsToAlias ?? "the manager")")
                } else {
                    card(title: "Reports to nobody", sub: "Top of the org chart — no manager set", chevron: false)
                        .accessibilityElement(children: .combine)
                }
                if canEdit {
                    Button {
                        editing = true
                    } label: {
                        Label("Change manager…", systemImage: "arrow.triangle.branch")
                            .ltype(.meta)
                            .foregroundStyle(p.accent)
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 4)
                    .accessibilityHint("Pick who \(alias) reports to")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: agentId) { await load() }
        .sheet(isPresented: $editing) {
            ReportsToPickerSheet(
                agentId: agentId,
                alias: alias,
                currentManagerId: line?.reportsToAgentId
            ) { saved in
                line = saved
            }
        }
    }

    private func card(title: String, sub: String?, chevron: Bool) -> some View {
        LCard {
            HStack(spacing: LSpace.s) {
                Image(systemName: "person.2.wave.2")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(p.text2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .ltype(.bodyEmph)
                        .foregroundStyle(p.text)
                    if let sub {
                        Text(sub)
                            .ltype(.meta)
                            .foregroundStyle(p.muted)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if chevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(p.faint)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 32)
        }
    }

    private func load() async {
        guard let base = model.selectedContainer?.baseUrl else { return }
        if let fresh = try? await model.api.reportsTo(base, agentId) { line = fresh }
    }

    /// "atlas › lead › owner" — the chain from the direct manager upward, when it is
    /// longer than the manager alone.
    private func chainText(_ line: ReportsToDto) -> String? {
        let names = line.chain.compactMap(\.alias)
        guard names.count > 1 else { return nil }
        return "Chain: " + names.joined(separator: " › ")
    }
}
