import SwiftUI

/// Projects screen's compact "Usage" card: the overall max %, then one row per
/// provider with its most-constrained window. The whole card opens the detail sheet.
struct PlanUsageCard: View {
    @Environment(\.palette) private var p
    let providers: [PlanUsageUx.Provider]
    let loaded: Bool
    let onOpen: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date
            Button(action: onOpen) {
                LCard {
                    VStack(alignment: .leading, spacing: LSpace.s) {
                        header
                        if !loaded {
                            SkeletonBlock(height: 14).frame(maxWidth: 180)
                        } else if providers.isEmpty {
                            Text(PlanUsageUx.emptyText)
                                .ltype(.meta)
                                .foregroundStyle(p.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            ForEach(providers) { provider in
                                PlanUsageCompactRow(provider: provider, now: now)
                            }
                            if let newest = PlanUsageUx.newest(providers) {
                                PlanUsageFreshness(host: newest.host, capturedAt: newest.capturedAt, now: now)
                            }
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Plan usage")
            .accessibilityValue(accessibilityValue(now: now))
            .accessibilityHint("Opens plan usage details")
            .accessibilityAddTraits(.isButton)
        }
    }

    private var header: some View {
        HStack(spacing: LSpace.s) {
            Text("Usage")
                .ltype(.meta)
                .fontWeight(.medium)
                .foregroundStyle(p.text2)
            Spacer(minLength: LSpace.s)
            if loaded, let overall = PlanUsageUx.overallPercent(providers) {
                PlanUsagePercent(percent: Double(overall))
                    .fontWeight(.semibold)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(p.faint)
        }
    }

    private func accessibilityValue(now: Date) -> String {
        guard loaded else { return "Loading" }
        guard !providers.isEmpty else { return PlanUsageUx.emptyText }
        var parts: [String] = []
        if let overall = PlanUsageUx.overallPercent(providers) { parts.append("\(overall) percent overall") }
        parts += providers.map { PlanUsageUx.providerAccessibility($0, now: now) }
        if let newest = PlanUsageUx.newest(providers) {
            parts.append(PlanUsageUx.updatedText(host: newest.host, capturedAt: newest.capturedAt, now: now))
            if PlanUsageUx.isStale(newest.capturedAt, now: now) { parts.append("may be out of date") }
        }
        return parts.joined(separator: ". ")
    }
}

/// One provider in the compact card: mark · name · plan … % / bar · resets in.
private struct PlanUsageCompactRow: View {
    @Environment(\.palette) private var p
    let provider: PlanUsageUx.Provider
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let mark = provider.mark {
                    ProviderMarkImage(provider: mark, size: 14)
                }
                Text(provider.name)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                if let plan = provider.plan {
                    Text(plan).ltype(.meta).foregroundStyle(p.muted)
                }
                Spacer(minLength: LSpace.s)
                if let w = provider.constrained {
                    PlanUsagePercent(percent: w.usedPct)
                }
            }
            if let w = provider.constrained {
                HStack(spacing: LSpace.s) {
                    PlanUsageBar(percent: w.usedPct, thin: true)
                    if let resets = PlanUsageUx.resetsInText(w.resetsAt, now: now) {
                        Text(resets)
                            .ltype(.micro)
                            .monospacedDigit()
                            .foregroundStyle(p.muted)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
            }
        }
    }
}

/// `Updated 2m ago from Husseins-MacBook-Pro`, plus a muted "may be out of date" after 30 min.
struct PlanUsageFreshness: View {
    @Environment(\.palette) private var p
    let host: String
    let capturedAt: Date?
    let now: Date

    var body: some View {
        let stale = PlanUsageUx.isStale(capturedAt, now: now)
        Text(PlanUsageUx.updatedText(host: host, capturedAt: capturedAt, now: now) + (stale ? " · may be out of date" : ""))
            .ltype(.micro)
            .foregroundStyle(stale ? p.faint : p.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
