import Charts
import SwiftUI

/// Metrics summary (web `StatCards` + `DailyBars`): Est. cost, Runs, Tokens (in · out),
/// Sandbox compute and Tasks, then runs per UTC day.
struct UsageSummarySection: View {
    @Environment(\.palette) private var p
    let data: MetricsSummaryDto

    var body: some View {
        let t = data.totals
        let unreported = UsageUx.costUnreported(t)
        let agents = data.perAgent.count
        VStack(alignment: .leading, spacing: LSpace.s) {
            UsageTileGrid {
                UsageStatTile(label: "Est. cost (USD)",
                              value: unreported ? "Not reported" : UsageUx.usd(t.estCostUsd),
                              sub: UsageUx.costCaptionShort(t), unknown: unreported)
                UsageStatTile(label: "Runs", value: "\(t.runs)",
                              sub: agents > 0 ? "across \(UsageUx.plural(agents, "agent"))" : nil)
                UsageStatTile(label: "Tokens (in · out)",
                              value: UsageUx.tokens(t.tokensIn) + " · " + UsageUx.tokens(t.tokensOut),
                              sub: "excl. cache")
                UsageStatTile(label: "Sandbox compute", value: UsageUx.duration(t.sandboxSeconds), sub: "wall-clock")
                UsageStatTile(label: "Tasks", value: "\(t.tasksCompleted) done", sub: "\(t.tasksVerified) human-verified")
            }
            if !data.daily.isEmpty {
                LCard { UsageDailyBars(days: data.daily, window: data.days, complete: UsageUx.costComplete(t)) }
            }
        }
    }
}

/// Runs per UTC day — one series, peak on the right, first/last day under the axis.
struct UsageDailyBars: View {
    @Environment(\.palette) private var p
    let days: [MetricsDayDto]
    let window: Int
    let complete: Bool

    var body: some View {
        let peak = days.map(\.runs).max() ?? 0
        VStack(alignment: .leading, spacing: LSpace.s) {
            HStack {
                Text("Runs per UTC day").ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2)
                Spacer()
                Text("peak \(peak)").ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
            }
            Chart(days) { day in
                BarMark(x: .value("Day", day.date), y: .value("Runs", day.runs))
                    .foregroundStyle(p.accent)
                    .cornerRadius(2)
                    .accessibilityLabel(UsageUx.day(day.date))
                    .accessibilityValue(tip(day))
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartYScale(domain: 0...max(peak, 1))
            .frame(height: 90)
            HStack {
                Text(days.first.map { UsageUx.day($0.date) } ?? "")
                Spacer()
                Text(days.last.map { UsageUx.day($0.date) } ?? "")
            }
            .ltype(.micro)
            .foregroundStyle(p.faint)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Runs per day over the last \(window) days, peak \(peak)")
    }

    private func tip(_ d: MetricsDayDto) -> String {
        var s = UsageUx.plural(d.runs, "run")
        if d.runs > 0 {
            s += ", " + (d.estCostUsd > 0 || complete ? UsageUx.usd(d.estCostUsd) : "cost not reported")
        }
        return s
    }
}

/// "Cost & activity by agent": one compact two-line row per agent, by cost.
struct UsageAgentsSection: View {
    @Environment(\.palette) private var p
    let data: MetricsSummaryDto
    let catalog: [ModelDto]
    let window: String

    var body: some View {
        let agents = UsageUx.sortedAgents(data)
        let complete = UsageUx.costComplete(data.totals)
        let maxCost = agents.map(\.estCostUsd).max() ?? 0
        LSection("Cost & activity by agent", count: agents.count) {
            if agents.isEmpty {
                Text("No agent runs in this window.").ltype(.meta).foregroundStyle(p.muted)
            } else {
                LCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(agents) { agent in
                            NavigationLink(value: UsageAgentRoute(agentId: agent.agentId, alias: agent.alias ?? "Agent",
                                                                  model: agent.model, window: window)) {
                                UsageAgentRow(agent: agent, modelName: UsageUx.modelName(agent.model, catalog: catalog),
                                              complete: complete, maxCost: maxCost)
                            }
                            .buttonStyle(.lRow)
                            .accessibilityHint("Shows spend detail")
                            if agent.id != agents.last?.id { LDivider(inset: LSpace.m) }
                        }
                    }
                }
            }
        }
    }
}

private struct UsageAgentRow: View {
    @Environment(\.palette) private var p
    let agent: MetricsAgentDto
    let modelName: String?
    let complete: Bool
    let maxCost: Double

    var body: some View {
        let known = agent.estCostUsd > 0 || complete
        let cost = UsageUx.rowCost(agent.estCostUsd, complete: complete)
        let share = UsageUx.costBarFraction(agent.estCostUsd, max: maxCost, known: known)
        let health = UsageUx.health(failed: agent.failedRuns, total: agent.runs)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: LSpace.s) {
                LAvatar(name: agent.alias ?? "?", isAI: true, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.alias ?? "?").ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                    HStack(spacing: 4) {
                        ModelProviderMark(model: agent.model, size: 11)
                        Text(modelName ?? "Model not recorded")
                            .ltype(.micro)
                            .foregroundStyle(modelName == nil ? p.faint : p.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: LSpace.s)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(cost ?? "not reported")
                        .ltype(cost == nil ? .micro : .bodyEmph)
                        .monospacedDigit()
                        .foregroundStyle(cost == nil ? p.faint : p.text)
                    if let share {
                        UsageShareBar(fraction: share).frame(width: 64)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(p.faint)
                    .accessibilityHidden(true)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: LSpace.s) { facts(health) }
                VStack(alignment: .leading, spacing: 4) { facts(health) }
            }
            .padding(.leading, 34)
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11y(cost: cost, health: health))
    }

    @ViewBuilder
    private func facts(_ health: UsageUx.Health) -> some View {
        UsageHealthChip(health: health)
        Text("\(agent.okRuns) / \(agent.runs) runs").ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
        Text(UsageUx.duration(agent.sandboxSeconds)).ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
        Text(tokensText).ltype(.micro).monospacedDigit().foregroundStyle(p.muted).lineLimit(1)
    }

    private var tokensText: String {
        UsageUx.tokensReported(agent)
            ? "\(UsageUx.tokens(agent.tokensIn)) in · \(UsageUx.tokens(agent.tokensOut)) out"
            : "tokens not reported"
    }

    private func a11y(cost: String?, health: UsageUx.Health) -> String {
        [agent.alias ?? "Agent", modelName ?? "Model not recorded", UsageUx.healthLabel(health),
         UsageUx.healthDetail(agent), "compute \(UsageUx.duration(agent.sandboxSeconds))", tokensText,
         "cost " + (cost ?? "not reported")].joined(separator: ", ")
    }
}

/// The ⓘ "How cost is estimated" popover next to the range pills.
struct UsageCostInfoButton: View {
    @Environment(\.palette) private var p
    let scope: String
    @State private var open = false

    var body: some View {
        Button {
            open.toggle()
        } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(p.muted)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("How cost is estimated")
        .popover(isPresented: $open) {
            VStack(alignment: .leading, spacing: LSpace.s) {
                Text("How cost is estimated").ltype(.headline).foregroundStyle(p.text)
                Text(scope).ltype(.micro).foregroundStyle(p.muted)
                Text(UsageUx.costExplainer).ltype(.meta).foregroundStyle(p.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(LSpace.l)
            .frame(idealWidth: 320)
            .presentationCompactAdaptation(.popover)
        }
    }
}
