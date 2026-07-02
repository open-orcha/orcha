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

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("PLAN APPROVAL")
                            .font(.system(size: 11, weight: .bold)).tracking(0.8)
                            .foregroundStyle(p.violet)
                        Text(task.title).font(.system(size: 17, weight: .bold))
                        if let author = task.planMessage?.authorAlias {
                            HStack(spacing: 8) {
                                AgentAvatar(alias: author, size: 30)
                                Text("\(author) proposes a plan")
                                    .font(.system(size: 13)).foregroundStyle(p.text2)
                            }
                        }
                        SectionH(title: "Proposed plan")
                        OrchaCard(container: p.surface2) {
                            Text(task.planMessage?.body ?? "No plan text found on the thread.")
                                .font(.system(size: 15))
                                .foregroundStyle(p.text)
                        }
                        if rejecting {
                            TextField("What should change?", text: $reason, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                            Text("\(task.planMessage?.authorAlias ?? "The agent") sees this on the next wake — required.")
                                .font(.system(size: 13)).foregroundStyle(p.muted)
                            HStack(spacing: 8) {
                                KitButton(title: "Send back with changes", role: .dangerTonal, enabled: !reason.isEmpty && !model.actionInFlight) {
                                    Task { if await model.decidePlan(task, approve: false, reason: reason) { dismiss() } }
                                }
                                KitButton(title: "Cancel", role: .neutral) { rejecting = false }
                            }
                        } else {
                            HStack(spacing: 8) {
                                KitButton(title: "Approve plan", role: .okTonal, enabled: !model.actionInFlight) {
                                    Task { if await model.decidePlan(task, approve: true, reason: nil) { dismiss() } }
                                }
                                KitButton(title: "Request changes…", role: .dangerTonal) { rejecting = true }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
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

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("VERIFY TASK")
                            .font(.system(size: 11, weight: .bold)).tracking(0.8)
                            .foregroundStyle(p.ok)
                        Text(task.title).font(.system(size: 17, weight: .bold))
                        SectionH(title: "Definition of done")
                        OrchaCard(borderColor: p.okLine, container: p.surface2) {
                            Text(task.definitionOfDone ?? "No definition of done was provided.")
                                .font(.system(size: 15)).foregroundStyle(p.text)
                        }
                        if let claimed = task.result ?? task.messageSummary?.last?.body {
                            SectionH(title: "Claimed result")
                            OrchaCard(container: p.surface2) {
                                Text(claimed).font(.system(size: 15)).foregroundStyle(p.text2).lineLimit(8)
                            }
                        }
                        if rejecting {
                            TextField("What's missing?", text: $feedback, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(p.surface2, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border2, lineWidth: 1))
                            Text("Returns the task to in progress — required.")
                                .font(.system(size: 13)).foregroundStyle(p.muted)
                            HStack(spacing: 8) {
                                KitButton(title: "Send back", role: .dangerTonal, enabled: !feedback.isEmpty && !model.actionInFlight) {
                                    Task { if await model.verifyTask(task.id, approve: false, feedback: feedback) { dismiss() } }
                                }
                                KitButton(title: "Cancel", role: .neutral) { rejecting = false }
                            }
                        } else {
                            HStack(spacing: 8) {
                                KitButton(title: "Approve & complete", role: .okTonal, enabled: !model.actionInFlight) {
                                    Task { if await model.verifyTask(task.id, approve: true, feedback: nil) { dismiss() } }
                                }
                                KitButton(title: "Send back…", role: .neutral) { rejecting = true }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
