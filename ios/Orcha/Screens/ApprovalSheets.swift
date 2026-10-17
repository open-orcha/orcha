import SwiftUI

/// Flow 08 — plan-approval sheet. Plan text renders in full (never truncated);
/// "Request changes" reveals a REQUIRED feedback field. Shared with task detail.
struct PlanApprovalSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto
    @State private var rejecting = false
    @State private var reason = ""
    @State private var approvedTick = 0
    /// GH #140 — a tapped task-id link pushes onto this sheet's own `NavigationStack`.
    @State private var linkedTaskId: String?

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        ApprovalHeader(kicker: "Plan approval", title: task.title, shortId: task.shortId)
                        if let author = task.planMessage?.authorAlias {
                            HStack(spacing: LSpace.s) {
                                LAvatar(name: author, isAI: true, size: 22)
                                Text("\(author) proposes a plan")
                                    .ltype(.meta)
                                    .foregroundStyle(p.text2)
                            }
                        }
                        if let body = task.planMessage?.body, !body.isEmpty {
                            PlanBriefCard(text: body)
                        }
                        LSection("Proposed plan") {
                            LCard(padding: LSpace.l) {
                                if let body = task.planMessage?.body, !body.isEmpty {
                                    LinkedMessageText(text: body, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                                        .ltype(.body)
                                        .foregroundStyle(p.text)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                } else {
                                    Text("No plan text found on the thread.")
                                        .ltype(.body)
                                        .foregroundStyle(p.faint)
                                }
                            }
                        }
                        // Collab v1: honest gating — a viewer / trusted non-member
                        // sees WHY the decision buttons are off (server 403s anyway).
                        if let denial = model.access.writeDenialReason {
                            Banner(kind: .info, text: denial)
                        }
                        if rejecting {
                            FeedbackField(
                                prompt: "What should change?",
                                note: "\(task.planMessage?.authorAlias ?? "The agent") sees this on the next wake. Required.",
                                text: $reason
                            )
                        }
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                    .animation(.lQuick, value: rejecting)
                }
                .background(p.surface)
                .safeAreaInset(edge: .bottom) { actions }
            }
            .navigationTitle("Review plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.success, trigger: approvedTick)
    }

    private var actions: some View {
        ApprovalActionBar {
            if rejecting {
                LButton("Cancel", kind: .ghost) { rejecting = false }
                LButton("Send back", kind: .danger, action: sendBack)
                    .disabled(reason.isEmpty || model.actionInFlight || !model.access.canWrite)
            } else {
                LButton("Request changes…", kind: .secondary) { rejecting = true }
                    .disabled(!model.access.canWrite)
                LButton("Approve plan", icon: "checkmark", kind: .primary, action: approve)
                    .disabled(model.actionInFlight || !model.access.canWrite)
            }
        }
    }

    private func approve() {
        Task {
            if await model.decidePlan(task, approve: true, reason: nil) {
                approvedTick += 1
                dismiss()
            }
        }
    }

    private func sendBack() {
        Task { if await model.decidePlan(task, approve: false, reason: reason) { dismiss() } }
    }
}

/// Flow 08 — verify sheet. Done-when + claimed result; "Reject…" reveals REQUIRED feedback.
struct VerifySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto
    @State private var rejecting: Bool
    @State private var feedback = ""
    @State private var acceptedTick = 0
    /// GH #140 — a tapped task-id link pushes onto this sheet's own `NavigationStack`.
    @State private var linkedTaskId: String?

    init(task: TaskDto, startRejecting: Bool = false) {
        self.task = task
        _rejecting = State(initialValue: startRejecting)
    }

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.l) {
                        ApprovalHeader(kicker: "Verify task", title: task.title, shortId: task.shortId)
                        if let claimed = task.result ?? task.messageSummary?.last.map({ ActivityCopy.humanize($0.body) }) {
                            LSection("Result") {
                                LCard(padding: LSpace.l) {
                                    LinkedMessageText(text: claimed, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                                        .ltype(.body)
                                        .foregroundStyle(p.text2)
                                        .lineLimit(12)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        LSection("Done when") {
                            LCard(padding: LSpace.l) {
                                HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                                    Image(systemName: "checkmark.circle")
                                        .foregroundStyle(p.ok)
                                        .accessibilityHidden(true)
                                    Text(task.definitionOfDone ?? "No definition of done was provided.")
                                        .ltype(.body)
                                        .foregroundStyle(p.text)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        // Collab v1: the assigned-reviewer chip ("review: <login>")
                        // when this verify belongs to someone else — informational,
                        // never a lock (the verify gate stays permissive).
                        if let tag = MobileUx.reviewTag(for: task, identity: model.identity) {
                            Banner(kind: .info, text: "Assigned to \(tag) for review — you can still verify if needed.")
                        }
                        // Honest gating — a viewer / trusted non-member sees WHY the
                        // buttons are off (the server 403s the write anyway).
                        if let denial = model.access.writeDenialReason {
                            Banner(kind: .info, text: denial)
                        }
                        if rejecting {
                            FeedbackField(
                                prompt: "What's missing?",
                                note: "Returns the task to in progress. Required.",
                                text: $feedback
                            )
                        }
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                    .animation(.lQuick, value: rejecting)
                }
                .background(p.surface)
                .safeAreaInset(edge: .bottom) { actions }
            }
            .navigationTitle("Verify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.surface, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.success, trigger: acceptedTick)
    }

    private var actions: some View {
        ApprovalActionBar {
            if rejecting {
                LButton("Cancel", kind: .ghost) { rejecting = false }
                LButton("Send back", kind: .danger, action: sendBack)
                    .disabled(feedback.isEmpty || model.actionInFlight || !model.access.canWrite)
            } else {
                LButton("Reject…", kind: .secondary) { rejecting = true }
                    .disabled(!model.access.canWrite)
                LButton("Accept", icon: "checkmark", kind: .primary, action: accept)
                    .disabled(model.actionInFlight || !model.access.canWrite)
            }
        }
    }

    private func accept() {
        Task {
            if await model.verifyTask(task.id, approve: true, feedback: nil) {
                acceptedTick += 1
                dismiss()
            }
        }
    }

    private func sendBack() {
        Task { if await model.verifyTask(task.id, approve: false, feedback: feedback) { dismiss() } }
    }
}

// MARK: - shared pieces

private struct ApprovalHeader: View {
    @Environment(\.palette) private var p
    let kicker: String
    let title: String
    let shortId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(kicker)
                Text("·").accessibilityHidden(true)
                Text(shortId).ltype(.mono)
            }
            .ltype(.meta)
            .foregroundStyle(p.faint)
            Text(title)
                .ltype(.title)
                .foregroundStyle(p.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

private struct FeedbackField: View {
    @Environment(\.palette) private var p
    let prompt: String
    let note: String
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(prompt, text: $text, axis: .vertical)
                .lineLimit(3...6)
                .ltype(.body)
                .focused($focused)
                .padding(LSpace.m)
                .background(p.surface2, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? p.accentLine : p.border, lineWidth: 1))
            Text(note)
                .ltype(.micro)
                .foregroundStyle(p.faint)
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .onAppear { focused = true }
    }
}

/// Bottom-pinned, right-aligned action bar: one primary, the rest secondary/ghost.
private struct ApprovalActionBar<Content: View>: View {
    @Environment(\.palette) private var p
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            LDivider()
            HStack(spacing: LSpace.s) {
                Spacer()
                content
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.s)
        }
        .background(p.surface)
    }
}
