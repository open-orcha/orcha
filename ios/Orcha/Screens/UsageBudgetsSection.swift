import SwiftUI

/// "Monthly budgets" (web `BudgetBars`, read-only): the project cap and every agent
/// with a budget, each as spend-vs-limit meters. With `agentId`, only that agent (and
/// nothing when neither it nor the project has a budget).
struct UsageBudgetsSection: View {
    @Environment(\.palette) private var p
    let budgets: ProjectBudgetsDto
    var agentId: String?

    var body: some View {
        let agents = UsageUx.budgetedAgents(budgets, agentId: agentId)
        let project = agentId == nil && (budgets.project?.state ?? "none") != "none" ? budgets.project : nil
        let unbudgeted = agentId == nil ? budgets.agents.filter { $0.state == "none" }.count : 0
        let projectNone = (budgets.project?.state ?? "none") == "none"
        if agentId == nil || !agents.isEmpty || !projectNone {
            LSection("Monthly budgets", trailing: AnyView(
                Text("\(AgentBudgetUx.period(budgets.period)) · resets \(AgentBudgetUx.reset(budgets.resetsAt)) (UTC)")
                    .ltype(.micro).foregroundStyle(p.muted).lineLimit(1)
            )) {
                VStack(alignment: .leading, spacing: LSpace.s) {
                    if project != nil || !agents.isEmpty {
                        LCard(padding: 0) {
                            VStack(spacing: 0) {
                                if let project {
                                    UsageBudgetRow(name: "Whole project", isProject: true, scope: project)
                                    if !agents.isEmpty { LDivider(inset: LSpace.m) }
                                }
                                ForEach(agents, id: \.agentId) { a in
                                    UsageBudgetRow(name: a.alias ?? "Agent", isProject: false, scope: a)
                                    if a.agentId != agents.last?.agentId { LDivider(inset: LSpace.m) }
                                }
                            }
                        }
                    }
                    if let agentId, let a = budgets.agents.first(where: { $0.agentId == agentId }),
                       a.blockedBy == "project", let reason = a.reason {
                        Text(reason).ltype(.meta).foregroundStyle(p.muted)
                    }
                    if agentId == nil && projectNone && agents.isEmpty {
                        Text("No monthly budgets set. Set one on an agent’s page, or for the project in Settings › Budgets & limits.")
                            .ltype(.meta).foregroundStyle(p.muted)
                    } else if unbudgeted > 0 {
                        Text("\(unbudgeted) \(unbudgeted == 1 ? "agent has" : "agents have") no budget.")
                            .ltype(.meta).foregroundStyle(p.faint)
                    }
                }
            }
        }
    }
}

private struct UsageBudgetRow: View {
    @Environment(\.palette) private var p
    let name: String
    let isProject: Bool
    let scope: AgentBudgetDto

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: LSpace.s) {
                if isProject {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(p.muted)
                        .frame(width: 20, height: 20)
                        .accessibilityHidden(true)
                } else {
                    LAvatar(name: name, isAI: true, size: 20)
                }
                Text(name).ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                Spacer(minLength: LSpace.s)
                if let label = AgentBudgetUx.healthLabel(scope) {
                    LChip(label, tint: tint)
                }
            }
            usdLine
            if let cap = scope.limits.tokens {
                VStack(alignment: .leading, spacing: 3) {
                    BudgetMeter(ratio: scope.tokenRatio)
                    Text("\(AgentBudgetUx.tokens(scope.usage.tokens)) of \(AgentBudgetUx.tokens(cap)) tokens · incl. cache")
                        .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
                }
            }
            if scope.usage.unmeteredRuns > 0, !scope.spendUnknown, scope.limits.usd != nil {
                let n = scope.usage.unmeteredRuns
                Text("+ \(n) \(n == 1 ? "run" : "runs") not metered (\(AgentBudgetUx.tokens(scope.usage.unmeteredTokens)) tokens incl. cache)")
                    .ltype(.micro).foregroundStyle(p.faint)
            }
            if let reason = scope.reason, scope.state == "exceeded" {
                Text(reason).ltype(.micro).foregroundStyle(p.muted)
            }
        }
        .padding(LSpace.m)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var usdLine: some View {
        if let limit = scope.limits.usd {
            if scope.spendUnknown {
                Text("Not metered · limit \(AgentBudgetUx.usd(limit))").ltype(.micro).foregroundStyle(p.faint)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    BudgetMeter(ratio: scope.usdRatio)
                    Text("\(AgentBudgetUx.usd(scope.usage.spendUsd)) of \(AgentBudgetUx.usd(limit)) · \(AgentBudgetUx.percent(scope.usdRatio))")
                        .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
                }
            }
        } else {
            Text("No dollar limit").ltype(.micro).foregroundStyle(p.faint)
        }
    }

    private var tint: Color {
        switch scope.state {
        case "warning": p.warn
        case "exceeded": p.danger
        default: p.ok
        }
    }
}
