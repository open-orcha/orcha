import SwiftUI

/// A plan-limit bar: neutral below 70 %, warn 70–90 %, danger from 90 %.
/// Decorative — the row it sits in carries the VoiceOver value.
struct PlanUsageBar: View {
    @Environment(\.palette) private var p
    let percent: Double
    var thin = false

    var body: some View {
        let fraction = PlanUsageUx.clamp(percent) / 100
        Capsule()
            .fill(p.surface3)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule()
                        .fill(fill)
                        .frame(width: max(fraction > 0 ? 3 : 0, geo.size.width * fraction))
                }
            }
            .clipShape(Capsule())
            .frame(height: thin ? 4 : 6)
            .accessibilityHidden(true)
    }

    private var fill: Color {
        switch PlanUsageUx.tone(percent) {
        case .neutral: p.text2
        case .warn: p.warn
        case .danger: p.danger
        }
    }
}

/// Percent text tinted by the same thresholds as the bar.
struct PlanUsagePercent: View {
    @Environment(\.palette) private var p
    let percent: Double

    var body: some View {
        Text("\(Int(PlanUsageUx.clamp(percent).rounded()))%")
            .ltype(.meta)
            .monospacedDigit()
            .foregroundStyle(tint)
    }

    private var tint: Color {
        switch PlanUsageUx.tone(percent) {
        case .neutral: p.text2
        case .warn: p.warn
        case .danger: p.danger
        }
    }
}
