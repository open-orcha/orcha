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
    /// GH #140 — a tapped task-id link pushes onto this sheet's own `NavigationStack`.
    @State private var linkedTaskId: String?

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("PLAN APPROVAL")
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        Text(task.title).font(p.uiFont(17, .bold))
                        if let author = task.planMessage?.authorAlias {
                            HStack(spacing: 8) {
                                AgentAvatar(alias: author, size: 30)
                                Text("\(author) proposes a plan")
                                    .font(p.uiFont(13)).foregroundStyle(p.text2)
                            }
                        }
                        if let body = task.planMessage?.body, !body.isEmpty {
                            PlanBriefCard(text: body)
                        }
                        SectionH(title: "Proposed plan")
                        OrchaCard(container: p.surface2) {
                            if let body = task.planMessage?.body, !body.isEmpty {
                                LinkedMessageText(text: body, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                                    .font(p.uiFont(15))
                                    .foregroundStyle(p.text)
                            } else {
                                Text("No plan text found on the thread.")
                                    .font(p.uiFont(15))
                                    .foregroundStyle(p.text)
                            }
                        }
                        // Collab v1: honest gating — a viewer / trusted non-member
                        // sees WHY the decision buttons are off (server 403s anyway).
                        if let denial = model.access.writeDenialReason {
                            Banner(kind: .info, text: denial)
                        }
                        if rejecting {
                            TextField("What should change?", text: $reason, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                            Text("\(task.planMessage?.authorAlias ?? "The agent") sees this on the next wake — required.")
                                .font(p.uiFont(13)).foregroundStyle(p.muted)
                            HStack(spacing: 8) {
                                KitButton(title: "Send back with changes", role: .dangerTonal, enabled: !reason.isEmpty && !model.actionInFlight && model.access.canWrite) {
                                    Task { if await model.decidePlan(task, approve: false, reason: reason) { dismiss() } }
                                }
                                KitButton(title: "Cancel", role: .neutral) { rejecting = false }
                            }
                        } else {
                            HStack(spacing: 8) {
                                KitButton(title: "Approve plan", role: .okTonal, enabled: !model.actionInFlight && model.access.canWrite) {
                                    Task { if await model.decidePlan(task, approve: true, reason: nil) { dismiss() } }
                                }
                                KitButton(title: "Request changes…", role: .dangerTonal, enabled: model.access.canWrite) { rejecting = true }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Flow 08 — verify sheet. DoD card + claimed result; "Send back" reveals REQUIRED feedback.
struct VerifySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let task: TaskDto
    @State private var rejecting = false
    @State private var feedback = ""
    /// GH #140 — a tapped task-id link pushes onto this sheet's own `NavigationStack`.
    @State private var linkedTaskId: String?

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("VERIFY TASK")
                            .font(p.uiFont(11, .bold)).tracking(0.8)
                            .foregroundStyle(p.ok)
                        Text(task.title).font(p.uiFont(17, .bold))
                        SectionH(title: "Definition of done")
                        OrchaCard(borderColor: p.okLine, container: p.surface2) {
                            Text(task.definitionOfDone ?? "No definition of done was provided.")
                                .font(p.uiFont(15)).foregroundStyle(p.text)
                        }
                        if let claimed = task.result ?? task.messageSummary?.last?.body {
                            SectionH(title: "Claimed result")
                            OrchaCard(container: p.surface2) {
                                LinkedMessageText(text: claimed, tasks: model.snapshot?.tasks ?? [], onTapTask: { linkedTaskId = $0 })
                                    .font(p.uiFont(15)).foregroundStyle(p.text2).lineLimit(8)
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
                            TextField("What's missing?", text: $feedback, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                            Text("Returns the task to in progress — required.")
                                .font(p.uiFont(13)).foregroundStyle(p.muted)
                            HStack(spacing: 8) {
                                KitButton(title: "Send back", role: .dangerTonal, enabled: !feedback.isEmpty && !model.actionInFlight && model.access.canWrite) {
                                    Task { if await model.verifyTask(task.id, approve: false, feedback: feedback) { dismiss() } }
                                }
                                KitButton(title: "Cancel", role: .neutral) { rejecting = false }
                            }
                        } else {
                            HStack(spacing: 8) {
                                KitButton(title: "Approve & complete", role: .okTonal, enabled: !model.actionInFlight && model.access.canWrite) {
                                    Task { if await model.verifyTask(task.id, approve: true, feedback: nil) { dismiss() } }
                                }
                                KitButton(title: "Send back…", role: .neutral, enabled: model.access.canWrite) { rejecting = true }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .navigationDestination(item: $linkedTaskId) { TaskDetailScreen(taskId: $0) }
        }
        .presentationDetents([.medium, .large])
    }
}
