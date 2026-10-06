import SwiftUI

/// Agent "History" — config revisions (web `AgentConfigHistory` parity): who changed
/// which setting when, each revision's before → after, and "Restore this version"
/// (confirm first; a restore creates a NEW revision, history is never rewritten).
struct AgentConfigHistoryScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let alias: String

    @State private var revisions: [ConfigRevisionDto] = []
    @State private var latest: Int?
    @State private var nextBefore: Int?
    @State private var loaded = false
    @State private var error: String?
    @State private var expanded: Int?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: LSpace.s) {
                if let error {
                    Banner(kind: .danger, text: error, action: "Retry") { Task { await reload() } }
                }
                if !loaded && error == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                        .accessibilityLabel("Loading history")
                } else if loaded && revisions.isEmpty {
                    LEmptyState(icon: "clock.arrow.circlepath", title: "No history yet",
                                message: "Changes to \(alias)'s settings show up here.")
                }
                ForEach(revisions) { rev in
                    ConfigRevisionCard(
                        agentId: agentId,
                        revision: rev,
                        isLatest: rev.revisionNo == latest,
                        expanded: expanded == rev.revisionNo,
                        onToggle: { expanded = expanded == rev.revisionNo ? nil : rev.revisionNo },
                        onRestored: { Task { await reload() } }
                    )
                }
                if let nextBefore {
                    LButton("Load older changes", icon: "arrow.down", kind: .ghost, size: .small) {
                        Task { await loadPage(before: nextBefore) }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(LSpace.l)
        }
        .background(p.bg)
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async {
        revisions = []
        nextBefore = nil
        await loadPage(before: nil)
    }

    private func loadPage(before: Int?) async {
        guard let base = model.selectedContainer?.baseUrl else { return }
        do {
            let page = try await model.api.configRevisions(base, agentId, before: before)
            revisions += page.revisions
            latest = page.latestRevisionNo ?? latest
            nextBefore = page.nextBefore
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = model.friendly(error)
        }
        loaded = true
    }
}

/// One revision: sentence + time; expands to its field changes and the restore bar.
private struct ConfigRevisionCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let revision: ConfigRevisionDto
    let isLatest: Bool
    let expanded: Bool
    let onToggle: () -> Void
    let onRestored: () -> Void

    @State private var detail: ConfigRevisionDetailDto?
    @State private var detailFailed = false
    @State private var confirming = false
    @State private var restoring = false

    var body: some View {
        LCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: onToggle) {
                    HStack(alignment: .top, spacing: LSpace.s) {
                        Image(systemName: glyph)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(p.muted)
                            .frame(width: 18)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(AgentConfigHistoryUx.sentence(revision))
                                .ltype(.body).foregroundStyle(p.text)
                                .multilineTextAlignment(.leading)
                            HStack(spacing: 6) {
                                Text("#\(revision.revisionNo)").ltype(.mono).foregroundStyle(p.faint)
                                if let ago = MobileUx.agoLabel(revision.createdAt) {
                                    Text(ago).ltype(.micro).foregroundStyle(p.faint)
                                }
                                if isLatest { LTag("Current") }
                            }
                        }
                        Spacer(minLength: 0)
                        if revision.kind != "initial" {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(p.faint)
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(LSpace.m)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")

                if expanded {
                    LDivider()
                    VStack(alignment: .leading, spacing: LSpace.s) {
                        if let reason = revision.reason, !reason.isEmpty {
                            Text("“\(reason)”").ltype(.meta).foregroundStyle(p.text2)
                        }
                        ForEach(Array(revision.changes.enumerated()), id: \.offset) { _, change in
                            changeRow(change)
                        }
                        if !isLatest { restoreBar }
                    }
                    .padding(LSpace.m)
                    .task { await loadDetail() }
                }
            }
        }
        .confirmationDialog(
            "Restore revision #\(revision.revisionNo)?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Restore") { Task { await restore() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(previewCopy)
        }
    }

    private var glyph: String {
        switch revision.kind {
        case "initial": "clock"
        case "restore": "arrow.uturn.backward"
        default: revision.actor == nil ? "person" : "pencil"
        }
    }

    private func changeRow(_ change: ConfigFieldChange) -> some View {
        let field = change.field
        let before = AgentConfigHistoryUx.value(field, change.before)
        let after = AgentConfigHistoryUx.value(field, change.after)
        let long = field == "system_prompt"
        return VStack(alignment: .leading, spacing: 2) {
            Text(AgentConfigHistoryUx.fieldLabel(field)).ltype(.micro).foregroundStyle(p.muted)
            if long {
                Text(after).ltype(.meta).foregroundStyle(p.text2).lineLimit(4)
            } else {
                Text("\(before) → \(after)").ltype(.meta).foregroundStyle(p.text)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(long ? "\(AgentConfigHistoryUx.fieldLabel(field)) changed" : "\(AgentConfigHistoryUx.fieldLabel(field)): \(before) to \(after)")
    }

    @ViewBuilder
    private var restoreBar: some View {
        let canRestore = model.humanId != nil
            && (model.access.canManage(Grant.manageAgents) || model.access.canManage(Grant.manageAutonomy))
        if let detail {
            if !detail.restoreBlocked.isEmpty {
                Text("Can't restore: " + detail.restoreBlocked.map { "\(AgentConfigHistoryUx.fieldLabel($0.field)) \($0.reason)" }.joined(separator: "; ") + ".")
                    .ltype(.micro).foregroundStyle(p.muted)
            } else if detail.restorePreview.isEmpty {
                Label("The current configuration matches this version.", systemImage: "checkmark")
                    .ltype(.micro).foregroundStyle(p.muted)
            } else {
                Text("Restoring changes " + detail.restorePreview.map { AgentConfigHistoryUx.fieldLabel($0.field).lowercased() }.joined(separator: ", "))
                    .ltype(.micro).foregroundStyle(p.muted)
                if canRestore {
                    LButton("Restore this version", icon: "arrow.counterclockwise", size: .small) { confirming = true }
                        .disabled(restoring)
                } else {
                    Text(model.access.writeDenialReason ?? "Needs the 'manage agents' permission")
                        .ltype(.micro).foregroundStyle(p.faint)
                }
            }
        } else if detailFailed {
            Text("Couldn't compare with the current configuration.").ltype(.micro).foregroundStyle(p.muted)
        } else {
            Text("Checking against the current configuration…").ltype(.micro).foregroundStyle(p.faint)
        }
    }

    private var previewCopy: String {
        guard let detail else { return "" }
        return detail.restorePreview.map {
            "\(AgentConfigHistoryUx.fieldLabel($0.field)): \(AgentConfigHistoryUx.value($0.field, $0.current)) → \(AgentConfigHistoryUx.value($0.field, $0.target))"
        }.joined(separator: "\n")
    }

    private func loadDetail() async {
        guard detail == nil, !isLatest, let base = model.selectedContainer?.baseUrl else { return }
        do {
            detail = try await model.api.configRevision(base, agentId, revision.revisionNo)
        } catch is CancellationError {
        } catch {
            detailFailed = true
        }
    }

    private func restore() async {
        guard let base = model.selectedContainer?.baseUrl, let actor = model.humanId else { return }
        restoring = true
        defer { restoring = false }
        do {
            let result = try await model.api.restoreConfigRevision(base, agentId, revision.revisionNo, actor: actor, reason: nil)
            let from = result.restoredFrom ?? revision.revisionNo
            model.toast = result.applied.isEmpty ? "Already matches #\(from)" : "Restored from #\(from)"
            await model.loadAgentDetail(agentId)
            onRestored()
        } catch {
            model.toast = "Restore failed — \(model.friendly(error))"
        }
    }
}
