import SwiftUI

/// "Token usage" — the tokens-vs-quota meter (`GET …/token-usage`): 5 hours / 7 days /
/// All time, total tokens + cost + runs, the plan-quota bar, the four-kind token mix,
/// the latest wake and who is burning (all time).
struct UsageTokenSection: View {
    @Environment(\.palette) private var p
    let usage: TokenUsageDto?
    let error: String?
    let retry: () -> Void

    @State private var window = "7d"

    var body: some View {
        LSection("Token usage") {
            VStack(alignment: .leading, spacing: LSpace.m) {
                LSegmented(UsageUx.meterWindows.map { ($0.key, $0.label) }, selection: $window)
                if let error {
                    LCard { UsageInlineError(text: "Token usage is temporarily unavailable. \(error)", retry: retry) }
                } else if let usage {
                    content(usage)
                } else {
                    LCard { UsageSkeleton(rows: 4) }
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ usage: TokenUsageDto) -> some View {
        let mix = usage.windows[window] ?? TokenMixDto()
        if mix.runs == 0 && mix.totalTokens == 0 {
            LCard {
                LEmptyState(icon: "gauge.with.dots.needle.0percent", title: "No measured usage yet",
                            message: "Figures appear once agents wake and record usage.")
                    .frame(maxWidth: .infinity)
            }
        } else {
            UsageTokenHero(mix: mix, windowLabel: label(window))
            LCard {
                VStack(alignment: .leading, spacing: LSpace.s) {
                    Text("Token mix").ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2)
                    UsageTokenMix(mix: mix)
                    Text(UsageUx.cacheNote).ltype(.micro).foregroundStyle(p.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        if let wake = usage.lastWake {
            UsageLastWakeCard(wake: wake)
        }
        if !usage.perAgent.isEmpty {
            UsageMeterAgents(agents: usage.perAgent)
        }
    }

    private func label(_ key: String) -> String {
        UsageUx.meterWindows.first { $0.key == key }?.label ?? key
    }
}

private struct UsageTokenHero: View {
    @Environment(\.palette) private var p
    let mix: TokenMixDto
    let windowLabel: String

    var body: some View {
        LCard {
            VStack(alignment: .leading, spacing: LSpace.m) {
                HStack(alignment: .firstTextBaseline, spacing: LSpace.l) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Total tokens").ltype(.micro).foregroundStyle(p.muted)
                        Text(UsageUx.tokens(mix.totalTokens)).ltype(.display).monospacedDigit().foregroundStyle(p.text)
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Cost (USD)").ltype(.micro).foregroundStyle(p.muted)
                        Text(mix.totalCostUsd > 0 ? UsageUx.usd(mix.totalCostUsd) : "Not reported")
                            .ltype(mix.totalCostUsd > 0 ? .title : .meta)
                            .monospacedDigit()
                            .foregroundStyle(mix.totalCostUsd > 0 ? p.text : p.faint)
                        Text(UsageUx.plural(mix.runs, "run")).ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(windowLabel): \(UsageUx.tokens(mix.totalTokens)) tokens, " +
                                    (mix.totalCostUsd > 0 ? UsageUx.usd(mix.totalCostUsd) : "cost not reported") +
                                    ", \(UsageUx.plural(mix.runs, "run"))")
                quota
            }
        }
    }

    @ViewBuilder
    private var quota: some View {
        if UsageUx.quotaFraction(mix) != nil, let cap = mix.quotaTokens {
            let pct = mix.pctOfQuota ?? 0
            VStack(alignment: .leading, spacing: 4) {
                BudgetMeter(ratio: pct / 100)
                HStack {
                    Text("\(UsageUx.tokens(mix.totalTokens)) of \(UsageUx.tokens(cap)) quota")
                    Spacer()
                    Text("\(Int(pct.rounded()))%")
                }
                .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Quota")
            .accessibilityValue("\(Int(pct.rounded())) percent of \(UsageUx.tokens(cap)) tokens")
        } else {
            HStack(spacing: 6) {
                Image(systemName: "gauge.with.dots.needle.0percent").accessibilityHidden(true)
                Text("Quota not configured")
            }
            .ltype(.micro)
            .foregroundStyle(p.faint)
        }
    }
}

private struct UsageLastWakeCard: View {
    @Environment(\.palette) private var p
    let wake: LastWakeDto

    var body: some View {
        LCard {
            HStack(spacing: LSpace.s) {
                LAvatar(name: wake.agentAlias ?? "?", isAI: true, size: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Latest wake").ltype(.micro).foregroundStyle(p.muted)
                    Text(wake.agentAlias ?? "Agent").ltype(.bodyEmph).foregroundStyle(p.text)
                    if let date = MobileUx.parseInstant(wake.endedAt) {
                        Text(date, format: .relative(presentation: .named)).ltype(.micro).foregroundStyle(p.faint)
                    }
                }
                Spacer(minLength: LSpace.s)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(UsageUx.tokens(wake.totalTokens) + " tokens").ltype(.meta).monospacedDigit().foregroundStyle(p.text)
                    Text(wake.totalCostUsd > 0 ? UsageUx.usd(wake.totalCostUsd) : "cost not reported")
                        .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Who is burning — all time, by tokens, with a share bar. Tap → spend drilldown.
private struct UsageMeterAgents: View {
    @Environment(\.palette) private var p
    let agents: [TokenUsageAgentDto]

    var body: some View {
        let total = max(1, agents.reduce(0) { $0 + $1.totalTokens })
        let top = Double(agents.map(\.totalTokens).max() ?? 1)
        VStack(alignment: .leading, spacing: LSpace.s) {
            Text("By agent · all time").ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2).padding(.horizontal, 4)
            LCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(agents) { a in
                        NavigationLink(value: UsageAgentRoute(agentId: a.agentId, alias: a.alias ?? "Agent", model: nil, window: "all")) {
                            row(a, share: Double(a.totalTokens) / Double(total), bar: Double(a.totalTokens) / max(top, 1))
                        }
                        .buttonStyle(.lRow)
                        .accessibilityHint("Shows spend detail")
                        if a.id != agents.last?.id { LDivider(inset: LSpace.m) }
                    }
                }
            }
        }
    }

    private func row(_ a: TokenUsageAgentDto, share: Double, bar: Double) -> some View {
        HStack(spacing: LSpace.s) {
            LAvatar(name: a.alias ?? "?", isAI: true, size: 26)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(a.alias ?? "Agent").ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                    Spacer(minLength: LSpace.s)
                    Text(UsageUx.tokens(a.totalTokens)).ltype(.meta).monospacedDigit().foregroundStyle(p.text)
                }
                UsageShareBar(fraction: bar)
                HStack {
                    Text(UsageUx.plural(a.runs, "run"))
                    Spacer()
                    Text((a.totalCostUsd > 0 ? UsageUx.usd(a.totalCostUsd) : "not reported") + " · " + UsageUx.percent(share))
                }
                .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(p.faint)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(a.alias ?? "Agent"), \(UsageUx.tokens(a.totalTokens)) tokens, \(UsageUx.percent(share)) of all tokens, \(UsageUx.plural(a.runs, "run")), " +
                            (a.totalCostUsd > 0 ? UsageUx.usd(a.totalCostUsd) : "cost not reported"))
    }
}
