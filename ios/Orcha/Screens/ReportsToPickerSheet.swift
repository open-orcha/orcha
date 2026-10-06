import SwiftUI

/// "Change manager…" — who an agent reports to (web Org panel's "Reports to" picker).
/// Humans first, then AI agents; never the agent itself or one of its own reports (no
/// loops). "Nobody (top of org)" clears the line. Owner / `manage_agents` only — the
/// server still enforces it (403) and refuses loops (409) and retired managers (422).
struct ReportsToPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let agentId: String
    let alias: String
    let currentManagerId: String?
    /// Called with the server's echo after a successful save.
    let onSaved: (ReportsToDto) -> Void

    /// nil = Nobody (top of org).
    @State private var picked: String?
    @State private var managerOf: [String: String] = [:]
    @State private var saving = false
    @State private var error: String?

    private var people: [AgentDto] { model.snapshot?.agents ?? [] }

    private var candidates: [AgentDto] {
        let ai = MobileUx.orderAgents(people.filter { $0.kind == "ai" })
        let humans = people.filter { $0.kind == "human" }
        let ids = AgentOrgUx.managerCandidates(
            for: agentId,
            people: (humans + ai).map { ($0.id, $0.kind == "human", $0.terminatedAt != nil || $0.status == "terminated") },
            managerOf: managerOf
        )
        let byId = Dictionary(people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.compactMap { byId[$0] }
    }

    var body: some View {
        let options = candidates
        let humans = options.filter { $0.kind == "human" }
        let ai = options.filter { $0.kind != "human" }
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        Text("Who does \(alias) report to? Escalations follow this line up the org chart.")
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                        LCard(padding: 0) {
                            row(id: nil, title: "Nobody (top of org)", sub: "No manager — top of the chart") {
                                Image(systemName: "arrow.up.to.line")
                                    .font(.footnote)
                                    .foregroundStyle(p.faint)
                                    .frame(width: 28, height: 28)
                                    .background(p.surface2, in: Circle())
                                    .accessibilityHidden(true)
                            }
                        }
                        if !humans.isEmpty { group("Humans", humans) }
                        if !ai.isEmpty { group("AI agents", ai) }
                        if let error {
                            Banner(kind: .danger, text: error)
                        }
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                }
                .background(p.surface)
                .safeAreaInset(edge: .bottom) {
                    LButton(confirmTitle(options), kind: .primary, action: save)
                        .frame(maxWidth: .infinity)
                        .disabled(picked == currentManagerId || saving)
                        .padding(.horizontal, LSpace.l)
                        .padding(.vertical, LSpace.s)
                        .background(p.surface)
                }
            }
            .navigationTitle("Reports to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.selection, trigger: picked)
        .onAppear { picked = currentManagerId }
        .task(id: model.selectedContainer?.id) { await loadLines() }
    }

    private func group(_ title: String, _ list: [AgentDto]) -> some View {
        LSection(title, count: list.count) {
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, person in
                        if index > 0 { LDivider() }
                        let human = person.kind == "human"
                        row(id: person.id, title: human ? (person.githubLogin ?? person.alias) : person.alias, sub: subtitle(person)) {
                            AgentAvatar(alias: person.alias, human: human, githubLogin: person.githubLogin, size: 28)
                        }
                    }
                }
            }
        }
    }

    private func subtitle(_ person: AgentDto) -> String {
        if person.kind == "human" { return person.memberRole?.capitalized ?? "Human" }
        if let role = person.role, !role.isEmpty { return role }
        return "AI agent"
    }

    private func confirmTitle(_ options: [AgentDto]) -> String {
        guard picked != currentManagerId else { return "Pick a manager" }
        guard let picked else { return "Clear — top of the org" }
        let name = options.first { $0.id == picked }.map { $0.kind == "human" ? ($0.githubLogin ?? $0.alias) : $0.alias }
        return "Report to \(name ?? "manager")"
    }

    private func loadLines() async {
        guard let sel = model.selectedContainer,
              let org = try? await model.api.orgLines(sel.baseUrl, sel.id) else { return }
        managerOf = Dictionary(org.agents.compactMap { r in r.reportsTo.map { (r.id, $0) } }, uniquingKeysWith: { a, _ in a })
    }

    private func save() {
        guard let base = model.selectedContainer?.baseUrl else { return }
        guard let actor = model.humanId else {
            error = "Pair this phone as a human member to change reporting lines."
            return
        }
        let target = picked
        Task {
            saving = true
            defer { saving = false }
            do {
                let line = try await model.api.setReportsTo(base, agentId, managerId: target, actor: actor)
                onSaved(line)
                OrgRevision.shared.bump()
                model.toast = AgentOrgUx.changedToast(alias: alias, managerAlias: line.reportsToAlias)
                dismiss()
            } catch let e as OrchaApiError {
                error = "Couldn't change the manager — " + (AgentOrgUx.serverDetail(e.body) ?? model.friendly(e))
            } catch {
                self.error = "Couldn't change the manager — " + model.friendly(error)
            }
        }
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
                        if id == currentManagerId { LTag("Current") }
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

/// Bumped after a reporting-line change so the Agents tab's Org view re-reads the lines.
@MainActor @Observable
final class OrgRevision {
    static let shared = OrgRevision()
    private(set) var value = 0
    func bump() { value += 1 }
}
