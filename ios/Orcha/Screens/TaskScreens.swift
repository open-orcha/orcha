import SwiftUI
import UIKit   // UIResponder keyboard notifications (Issue 2 — scroll composer above keyboard)

// Responsibility: Task detail presentation, approval gates, dependencies, thread, and runs.

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   A 1:1 port of the Android `TaskScreens.kt`. These are plain pushed screens:
   the tab's NavigationStack (WorkspaceScreen) owns navigation + destinations.
   ============================================================================= */

/// Flow 05 T4 — task detail: header, flow-08 gate cards, DoD, deps, thread, runs,
/// and the destructive close path (dialog → optional reason alert → cancelTask).
struct TaskDetailScreen: View {
    @Environment(AppModel.self) var model
    @Environment(\.palette) var p
    @Environment(\.dismiss) var dismiss
    let taskId: String

    @State var allRuns = false
    @State var confirmClose = false
    @State var reasonAlert = false
    @State var closeReason = ""
    @State var verifySheetTask: TaskDto?
    @State var planSheetTask: TaskDto?

    var task: TaskDto? { model.snapshot?.tasks.first { $0.id == taskId } }

    var closable: Bool {
        guard let task else { return false }
        return !task.isRoot && task.status != "completed" && task.status != "cancelled"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let task {
                    detail(task)
                } else {
                    OrchaCard {
                        Text("Task not found — refresh the workspace.")
                            .foregroundStyle(p.muted)
                    }
                }
                if let error = model.error {
                    Banner(kind: .danger, text: error)
                }
            }
            .padding(16)
        }
        .navigationTitle(task?.title ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Close task…", role: .destructive) { confirmClose = true }
                        .disabled(!closable)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Task actions")
            }
        }
        .confirmationDialog(
            "Close \(task?.title ?? "task")?",
            isPresented: $confirmClose,
            titleVisibility: .visible
        ) {
            Button("Close task", role: .destructive) { close(reason: nil) }
            Button("Add reason & close…") { reasonAlert = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The task is force-closed and anything waiting on it unblocks. A reason is routed to the assignee.")
        }
        .alert("Close task", isPresented: $reasonAlert) {
            TextField("Reason (recommended)", text: $closeReason)
            Button("Close task", role: .destructive) {
                let trimmed = closeReason.trimmingCharacters(in: .whitespacesAndNewlines)
                close(reason: trimmed.isEmpty ? nil : trimmed)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The assignee sees this reason on their next wake.")
        }
        .sheet(item: $verifySheetTask) { VerifySheet(task: $0) }
        .sheet(item: $planSheetTask) { PlanApprovalSheet(task: $0) }
        .task { await model.loadTaskDetail(taskId) }
        .refreshable {
            await model.refresh()
            await model.loadTaskDetail(taskId)
        }
    }

    func close(reason: String?) {
        Task {
            if await model.cancelTask(taskId, reason: reason) { dismiss() }
        }
    }

    @ViewBuilder
    func detail(_ task: TaskDto) -> some View {
        headerCard(task)
        gateCards(task)
        descriptionSection(task)
        dodSection(task)
        dependenciesSection(task)
        threadSection
        runsSection
    }

    // MARK: header

    func headerCard(_ task: TaskDto) -> some View {
        OrchaCard {
            HStack(spacing: 8) {
                StatusPill(status: task.status, domain: .task)
                let band = MobileUx.priorityBand(task.priority)
                MetaTag(
                    text: "P\(task.priority ?? 100)",
                    tint: band == .high ? p.danger : band == .elevated ? p.warn : nil
                )
                if task.isRoot { MetaTag(text: "root") }
                Spacer()
            }
            Text(task.title)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(p.text)
            HStack(spacing: 8) {
                if let assignee = task.assignees.first ?? task.ownerAlias {
                    AgentAvatar(alias: assignee, size: 30)
                    Text(assignee)
                        .font(.system(size: 13))
                        .foregroundStyle(p.text2)
                } else {
                    Text("unassigned")
                        .font(.system(size: 13))
                        .foregroundStyle(p.faint)
                }
            }
        }
    }

    // MARK: flow-08 violet gate cards

    @ViewBuilder
    func gateCards(_ task: TaskDto) -> some View {
        if task.status == "needs_verification" {
            OrchaCard(borderColor: p.violetLine) {
                Text("AWAITING YOUR VERIFICATION")
                    .font(.system(size: 11, weight: .bold)).tracking(0.8)
                    .foregroundStyle(p.violet)
                Text(task.result ?? "The agent marked this done — review against the definition of done.")
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
                    .lineLimit(4)
                KitButton(title: "Review & verify", small: true) { verifySheetTask = task }
            }
        }
        if task.planMessage != nil, task.planDecision == nil, task.status == "in_progress" {
            OrchaCard(borderColor: p.violetLine) {
                Text("PLAN AWAITING YOUR APPROVAL")
                    .font(.system(size: 11, weight: .bold)).tracking(0.8)
                    .foregroundStyle(p.violet)
                Text(task.planMessage?.body ?? "")
                    .font(.system(size: 13.5))
                    .foregroundStyle(p.text2)
                    .lineLimit(4)
                KitButton(title: "Review plan", small: true) { planSheetTask = task }
            }
        }
    }

}
