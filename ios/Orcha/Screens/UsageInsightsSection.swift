import SwiftUI

/// "How to reduce spending" (web `InsightsCard`): rule-based suggestions, no AI.
struct UsageInsightsSection: View {
    @Environment(\.palette) private var p
    let insights: [InsightDto]?
    let error: String?
    /// Says the window when it differs from the pills above ("last 7 days").
    var scope: String?
    var emptyText = "No insights yet."
    let retry: () -> Void

    var body: some View {
        LSection("How to reduce spending", trailing: scope.map {
            AnyView(Text($0).ltype(.micro).foregroundStyle(p.muted))
        }) {
            if let error {
                LCard { UsageInlineError(text: "Insights are temporarily unavailable. \(error)", retry: retry) }
            } else if let insights {
                if insights.isEmpty {
                    Text(emptyText).ltype(.meta).foregroundStyle(p.muted)
                } else {
                    LCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(insights) { insight in
                                UsageInsightRow(insight: insight)
                                if insight.id != insights.last?.id { LDivider(inset: LSpace.m) }
                            }
                        }
                    }
                }
            } else {
                LCard { UsageSkeleton(rows: 3) }
            }
        }
    }
}

private struct UsageInsightRow: View {
    @Environment(\.palette) private var p
    let insight: InsightDto

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
                LChip(UsageUx.severityLabel(insight.severity), tint: tint)
                Text(insight.title).ltype(.bodyEmph).foregroundStyle(p.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail = insight.detail {
                Text(detail).ltype(.meta).foregroundStyle(p.text2).fixedSize(horizontal: false, vertical: true)
            }
            if let action = insight.action {
                (Text("Suggested  ").fontWeight(.semibold).foregroundStyle(p.muted) + Text(action).foregroundStyle(p.text2))
                    .ltype(.meta)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(LSpace.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var tint: Color {
        switch insight.severity {
        case "high": p.danger
        case "medium": p.warn
        default: p.muted
        }
    }
}
