import SwiftUI

/// The AI manager's pre-review (web `ReviewRouteRow`, mig 057): "atlas (manager)
/// recommends approval: covers the DoD". Read-only — the pre-review is a recommendation
/// the manager records itself; a human still verifies. Renders nothing when there is none.
struct ManagerReviewRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let task: TaskDto

    @State private var review: ManagerReviewDto?
    @State private var routing: ReviewRoutingDto?

    var body: some View {
        // A stack, not a Group: an empty Group renders nothing, so `.task` would never
        // fire and the row could never load itself.
        VStack(alignment: .leading, spacing: LSpace.xs) {
            if let via = ManagerReviewUx.via(routing) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Review")
                        .ltype(.micro)
                        .foregroundStyle(p.faint)
                    Text("Reviewer: \(routing?.reviewerAlias ?? "anyone") · \(via)")
                        .ltype(.meta)
                        .foregroundStyle(p.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let line = ManagerReviewUx.line(review) {
                HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                    Image(systemName: icon(line.tone))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(p.evidenceColor(line.tone == .plain ? .muted : line.tone))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Review")
                            .ltype(.micro)
                            .foregroundStyle(p.faint)
                        Text(line.text + (MobileUx.agoLabel(review?.decidedAt).map { " · \($0)" } ?? ""))
                            .ltype(.meta)
                            .foregroundStyle(p.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Manager pre-review: \(line.text)")
            }
        }
        .task(id: task.id + task.status) {
            let extras = await model.fetchReviewExtras(task)
            review = extras?.managerReview
            routing = extras?.reviewRouting
        }
    }

    private func icon(_ tone: EvidenceTone) -> String {
        switch tone {
        case .ok: "checkmark.circle.fill"
        case .bad: "xmark.circle.fill"
        default: "sparkles"
        }
    }
}
