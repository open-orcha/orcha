import SwiftUI

/// Where a usage row navigates: one agent's spend drilldown in a given window.
struct UsageAgentRoute: Hashable {
    let agentId: String
    let alias: String
    let model: String?
    let window: String
}

/// A figure tile: muted label, big value, one-line caption (web `Stat`).
struct UsageStatTile: View {
    @Environment(\.palette) private var p
    let label: String
    let value: String
    var sub: String?
    var unknown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).ltype(.micro).foregroundStyle(p.muted).lineLimit(1)
            Text(value)
                .ltype(unknown ? .meta : .title)
                .monospacedDigit()
                .foregroundStyle(unknown ? p.faint : p.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let sub {
                Text(sub).ltype(.micro).foregroundStyle(p.faint).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(LSpace.m)
        .background(p.surface, in: RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: p.radiusCard, style: .continuous).strokeBorder(p.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// Two flexible columns of tiles.
struct UsageTileGrid<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: LSpace.s), GridItem(.flexible(), spacing: LSpace.s)],
                  spacing: LSpace.s) { content }
    }
}

/// A thin horizontal magnitude bar (cost share, token share).
struct UsageShareBar: View {
    @Environment(\.palette) private var p
    let fraction: Double
    var tint: Color?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(p.surface3)
                Capsule().fill(tint ?? p.accent).frame(width: max(3, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// Run health chip (web `HealthChip`): On track / At risk / Off track.
struct UsageHealthChip: View {
    @Environment(\.palette) private var p
    let health: UsageUx.Health

    var body: some View {
        LChip(UsageUx.healthLabel(health), tint: tint)
    }

    private var tint: Color {
        switch health {
        case .onTrack: p.ok
        case .atRisk: p.warn
        case .offTrack: p.danger
        case .noData: p.faint
        }
    }
}

/// The four token kinds as one stacked bar (one hue, four steps) plus a legend
/// with values and shares.
struct UsageTokenMix: View {
    @Environment(\.palette) private var p
    let mix: TokenMixDto

    var body: some View {
        let parts = UsageUx.mixParts(mix)
        VStack(alignment: .leading, spacing: LSpace.s) {
            if mix.totalTokens > 0 {
                GeometryReader { geo in
                    HStack(spacing: 2) {
                        ForEach(Array(parts.enumerated()), id: \.element.id) { i, part in
                            if part.value > 0 {
                                Rectangle()
                                    .fill(shade(i))
                                    .frame(width: max(2, (geo.size.width - 6) * part.fraction))
                            }
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 10)
                .accessibilityHidden(true)
            }
            Grid(alignment: .leading, horizontalSpacing: LSpace.m, verticalSpacing: 6) {
                ForEach(Array(parts.enumerated()), id: \.element.id) { i, part in
                    GridRow {
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2).fill(shade(i)).frame(width: 8, height: 8)
                                .accessibilityHidden(true)
                            Text(part.label).ltype(.meta).foregroundStyle(p.text2)
                        }
                        Text(UsageUx.tokens(part.value))
                            .ltype(.meta).monospacedDigit().foregroundStyle(p.text)
                            .gridColumnAlignment(.trailing)
                        Text(mix.totalTokens > 0 ? UsageUx.percent(part.fraction) : "—")
                            .ltype(.meta).monospacedDigit().foregroundStyle(p.muted)
                            .gridColumnAlignment(.trailing)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(part.label): \(UsageUx.tokens(part.value)) tokens, \(UsageUx.percent(part.fraction))")
                }
            }
        }
    }

    private func shade(_ i: Int) -> Color {
        p.accent.opacity([1.0, 0.72, 0.45, 0.24][min(i, 3)])
    }
}

/// Grey placeholder blocks while a section loads (web `Skeleton`).
struct UsageSkeleton: View {
    @Environment(\.palette) private var p
    var rows = 3

    var body: some View {
        VStack(alignment: .leading, spacing: LSpace.s) {
            ForEach(0..<rows, id: \.self) { i in
                RoundedRectangle(cornerRadius: 6)
                    .fill(p.surface3)
                    .frame(height: i == 0 ? 44 : 16)
                    .frame(maxWidth: i == rows - 1 ? 180 : .infinity, alignment: .leading)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }
}

/// A muted inline error with a Retry button (for secondary sections).
struct UsageInlineError: View {
    @Environment(\.palette) private var p
    let text: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: LSpace.s) {
            Text(text).ltype(.meta).foregroundStyle(p.muted).frame(maxWidth: .infinity, alignment: .leading)
            LButton("Retry", icon: "arrow.clockwise", kind: .secondary, size: .small, action: retry)
        }
    }
}

extension UsageUx {
    /// Human error copy for the usage screens.
    static func describe(_ error: Error) -> String {
        error is DecodingError
            ? "Unexpected response from the server. Check that Embodent is reachable and up to date."
            : InboxErrorText.describe(error)
    }
}
