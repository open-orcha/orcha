import SwiftUI

/// Home tab's compact "This week" usage card: est. cost (or tokens when no run
/// reported a cost) · run count · a 7-bar runs-per-day sparkline. The whole card is
/// one button that opens Metrics & usage.
struct HomeUsageCard: View {
    @Environment(\.palette) private var p
    /// nil while the first load is in flight.
    let summary: MetricsSummaryDto?
    let loaded: Bool
    let onOpen: () -> Void

    var body: some View {
        let s = UsageCardUx.summary(summary)
        Button(action: onOpen) {
            LCard {
                HStack(alignment: .center, spacing: LSpace.m) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("This week").ltype(.micro).foregroundStyle(p.muted)
                        if !loaded {
                            SkeletonBlock(height: 14)
                                .frame(maxWidth: 120)
                                .padding(.vertical, 4)
                        } else if let s {
                            Text(s.figure)
                                .ltype(.title)
                                .monospacedDigit()
                                .foregroundStyle(p.text)
                            Text(s.runs).ltype(.meta).foregroundStyle(p.muted)
                        } else {
                            Text(UsageCardUx.emptyText).ltype(.meta).foregroundStyle(p.text2)
                        }
                    }
                    Spacer(minLength: 0)
                    if loaded, s != nil, let summary {
                        UsageSparkline(bars: UsageCardUx.bars(summary.daily))
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(p.faint)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(loaded ? (s?.accessibilityLabel ?? UsageCardUx.emptyAccessibilityLabel)
                                   : "Usage this week: loading. Opens Metrics and usage.")
        .accessibilityAddTraits(.isButton)
    }
}

/// Seven tiny bars: the peak day in accent, others muted, zero days a 2pt tick.
private struct UsageSparkline: View {
    @Environment(\.palette) private var p
    let bars: [UsageCardUx.Bar]
    private let height: CGFloat = 24

    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ForEach(bars) { bar in
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(color(bar.kind))
                    .frame(width: 4, height: bar.kind == .zero ? 2 : max(3, height * bar.fraction))
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func color(_ kind: UsageCardUx.BarKind) -> Color {
        switch kind {
        case .peak: p.accent
        case .normal: p.muted.opacity(0.55)
        case .zero: p.border2
        }
    }
}
