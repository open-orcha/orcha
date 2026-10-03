import SwiftUI

/// Goal ancestry breadcrumb — "Objective › Parent › This task" (web `GoalChain`), above
/// the task title. Only stored facts: the project's stated objective (or "No objective
/// set"), real parent links, this task. Nothing renders while loading or on error (no
/// fake crumbs). Tapping a parent opens it.
struct TaskGoalChainBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let taskId: String

    @State private var crumbs: [GoalCrumb] = []

    var body: some View {
        // A stack, not a Group: an empty Group renders nothing, so `.task` would never
        // fire and the row could never load itself.
        VStack(spacing: 0) {
            if GoalChainUx.isWorthShowing(crumbs) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(Array(crumbs.enumerated()), id: \.element.id) { index, crumb in
                            if index > 0 {
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(p.faint)
                                    .accessibilityHidden(true)
                            }
                            crumbView(crumb)
                        }
                    }
                    .ltype(.meta)
                }
                .scrollIndicators(.hidden)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(GoalChainUx.spoken(crumbs))
            }
        }
        .task(id: taskId) { await load() }
    }

    @ViewBuilder
    private func crumbView(_ crumb: GoalCrumb) -> some View {
        switch crumb {
        case .objective(let text, let project):
            HStack(spacing: 4) {
                Image(systemName: "flag")
                    .font(.caption2)
                    .accessibilityHidden(true)
                if let text {
                    Text(Self.clip(text, 60))
                } else {
                    Text(project.isEmpty ? "No objective set" : "\(project) · No objective set")
                }
            }
            .foregroundStyle(text == nil ? p.faint : p.text2)
            .lineLimit(1)
            .accessibilityLabel(text.map { "Project objective: \($0)" } ?? "No objective set")
        case .gap(let label, let hint):
            Text(label)
                .foregroundStyle(p.faint)
                .accessibilityLabel(hint)
        case .parent(let id, let title, let status):
            NavigationLink(value: WorkspaceRoute.task(id)) {
                HStack(spacing: 4) {
                    if let status { LStatusGlyph(status: status, size: 12) }
                    Text(Self.clip(title, 40)).lineLimit(1)
                }
                .foregroundStyle(p.text2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Parent task: \(title)")
            .accessibilityHint("Opens the parent task")
        case .this:
            Text("This task")
                .foregroundStyle(p.faint)
        }
    }

    private static func clip(_ text: String, _ max: Int) -> String {
        text.count > max ? String(text.prefix(max - 1)) + "…" : text
    }

    private func load() async {
        guard let chain = try? await model.fetchGoalChain(taskId) else { return }
        crumbs = GoalChainUx.crumbs(chain)
    }
}
