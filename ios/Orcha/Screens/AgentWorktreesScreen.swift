import SwiftUI

/// Settings › Execution › Agent worktrees (web `AgentWorktreesSection`): automatic
/// clean-up and its grace period (`PUT …/agent-worktrees/settings`), the worktree list
/// (`GET …/agent-worktrees`), and "Clean up now" for the clean ones — a human request
/// (`POST …/agent-worktrees/actions`) the notifier carries out on the host. Owner or
/// manage_autonomy to change anything; read-only otherwise.
struct AgentWorktreesScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var data: AgentWorktreesDto?
    @State private var loadError: String?
    @State private var graceDraft = 7
    @State private var busy = false
    @State private var notice: String?
    @State private var actionError: String?
    @State private var confirmCleanup = false

    private var canEdit: Bool { model.access.canManage(Grant.manageAutonomy) }

    private var items: [WorktreeItemDto] {
        let order = ["clean": 0, "has-output": 1, "unmerged": 2, "in-use": 3, "not-quorate": 4]
        return (data?.inventory?.items ?? []).sorted {
            (order[$0.state] ?? 9, -($0.sizeBytes ?? 0)) < (order[$1.state] ?? 9, -($1.sizeBytes ?? 0))
        }
    }

    private var cleanCount: Int { items.filter { $0.state == "clean" }.count }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                Text("Agents work in their own git worktrees under .orcha-worktrees. Clean ones are removed automatically; output is attached to its task (or kept in .orcha/saved-output) before a worktree with output is removed; unmerged commits are never removed automatically.")
                    .ltype(.meta)
                    .foregroundStyle(p.text2)
                if let notice { Banner(kind: .info, text: notice) }
                if let actionError { Banner(kind: .danger, text: actionError) }
                if let data {
                    settingsCard(data.settings)
                    listSection
                } else if let loadError {
                    LEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load agent worktrees", message: loadError, actionTitle: "Try again") {
                        Task { await load() }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, LSpace.xl)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle("Agent worktrees")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Clean up clean worktrees?", isPresented: $confirmCleanup, titleVisibility: .visible) {
            Button("Clean up \(cleanCount)") { Task { await cleanup() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only Embodent scaffolding is in them. The worktrees and their branches are removed. Worktrees with output or unmerged commits are left alone.")
        }
    }

    private func settingsCard(_ s: WorktreeSettingsDto) -> some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.m) {
                Toggle(isOn: Binding(
                    get: { s.autoCleanup },
                    set: { on in Task { await save(autoCleanup: on, graceDays: nil) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Clean up agent worktrees automatically").ltype(.bodyEmph).foregroundStyle(p.text)
                        Text("Removes clean worktrees after each run and in an hourly sweep. Worktrees with output are kept for the grace period after their task ends.")
                            .ltype(.micro).foregroundStyle(p.muted)
                    }
                }
                .disabled(!canEdit || busy)
                LDivider()
                Stepper(value: $graceDraft, in: ProjectLimitsUx.graceRange) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Grace period: \(graceDraft) \(graceDraft == 1 ? "day" : "days")").ltype(.bodyEmph).foregroundStyle(p.text)
                        Text("Days a worktree with output is kept after its task is completed or cancelled.")
                            .ltype(.micro).foregroundStyle(p.muted)
                    }
                }
                .disabled(!canEdit || busy)
                .accessibilityValue("\(graceDraft) days")
                if canEdit && graceDraft != s.graceDays {
                    LButton("Save", kind: .primary, size: .small) {
                        Task { await save(autoCleanup: nil, graceDays: ProjectLimitsUx.clampGrace(graceDraft)) }
                    }
                    .disabled(busy)
                }
                if !canEdit, let reason = model.access.manageDenialReason(Grant.manageAutonomy, action: "Changing worktree clean-up") {
                    Text(reason).ltype(.micro).foregroundStyle(p.muted)
                }
            }
        }
    }

    @ViewBuilder
    private var listSection: some View {
        let inventory = data?.inventory
        LSection("Worktrees", count: inventory == nil ? nil : items.count) {
            VStack(alignment: .leading, spacing: LSpace.s) {
                if inventory == nil {
                    Text("The notifier hasn't reported its worktrees yet — they show up once it runs (orcha up starts it).")
                        .ltype(.meta).foregroundStyle(p.muted)
                } else if items.isEmpty {
                    Text("No agent worktrees — nothing to clean up.").ltype(.meta).foregroundStyle(p.muted)
                } else {
                    if let inv = inventory, inv.totalBytes > 0 {
                        Text("\(ProjectLimitsUx.bytes(inv.totalBytes)) in total · \(ProjectLimitsUx.bytes(inv.reclaimableBytes)) reclaimable")
                            .ltype(.micro).foregroundStyle(p.muted)
                    }
                    LCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(items) { item in
                                row(item)
                                if item.id != items.last?.id { LDivider(inset: LSpace.m) }
                            }
                        }
                    }
                }
                if canEdit && cleanCount > 0 {
                    LButton("Clean up now (\(cleanCount))", icon: "trash", size: .small) { confirmCleanup = true }
                        .disabled(busy)
                }
            }
        }
    }

    private func row(_ item: WorktreeItemDto) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(item.name).ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                Spacer(minLength: LSpace.s)
                LTag(ProjectLimitsUx.worktreeState(item.state), tint: tint(item.state))
            }
            Text(subtitle(item)).ltype(.micro).foregroundStyle(p.muted).lineLimit(2)
        }
        .padding(LSpace.m)
        .accessibilityElement(children: .combine)
    }

    private func subtitle(_ item: WorktreeItemDto) -> String {
        var parts: [String] = []
        parts.append(item.agent ?? (item.state == "not-quorate" ? "Not an agent worktree" : "—"))
        if let task = item.taskTitle, !task.isEmpty {
            parts.append(task)
        } else if item.kind == "resident" {
            parts.append("Conversation")
        } else if item.kind == "live" {
            parts.append("Live terminal")
        }
        if let size = item.sizeBytes { parts.append(ProjectLimitsUx.bytes(size)) }
        if let ago = MobileUx.agoLabel(item.lastActivityAt) { parts.append(ago) }
        return parts.joined(separator: " · ")
    }

    private func tint(_ state: String) -> Color? {
        switch state {
        case "clean": p.ok
        case "unmerged": p.warn
        case "in-use", "has-output": p.accent
        default: nil
        }
    }

    // MARK: actions

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        do {
            let d = try await model.api.agentWorktrees(sel.baseUrl, sel.id)
            data = d
            graceDraft = d.settings.graceDays
            loadError = nil
        } catch {
            loadError = InboxErrorText.describe(error)
        }
    }

    private func save(autoCleanup: Bool?, graceDays: Int?) async {
        guard let sel = model.selectedContainer, canEdit else { return }
        busy = true
        defer { busy = false }
        do {
            let s = try await model.api.putWorktreeSettings(sel.baseUrl, sel.id, actor: model.humanId, autoCleanup: autoCleanup, graceDays: graceDays)
            data?.settings = s
            graceDraft = s.graceDays
            notice = autoCleanup == nil ? "Grace period set to \(s.graceDays) days."
                : (s.autoCleanup ? "Automatic clean-up is on." : "Automatic clean-up is off.")
            actionError = nil
        } catch {
            actionError = "Couldn't change the setting — " + InboxErrorText.describe(error)
        }
    }

    /// File the request, then poll briefly for the notifier's answer (web: every 2 s).
    private func cleanup() async {
        guard let sel = model.selectedContainer, canEdit else { return }
        busy = true
        defer { busy = false }
        do {
            var action = try await model.api.requestWorktreeCleanup(sel.baseUrl, sel.id, actor: model.humanId)
            var tries = 0
            while action.pending && tries < 15 {
                try await Task.sleep(for: .seconds(2))
                action = try await model.api.worktreeAction(sel.baseUrl, sel.id, actionId: action.id)
                tries += 1
            }
            if action.pending {
                notice = "Waiting for the notifier — it runs this as soon as it's back."
            } else if action.status == "failed" {
                actionError = "Not done — " + (action.error ?? "the notifier couldn't do it") + "."
            } else {
                notice = "Clean-up done."
                actionError = nil
            }
            await load()
        } catch is CancellationError {
            return
        } catch {
            actionError = "Couldn't send that — " + InboxErrorText.describe(error)
        }
    }
}
