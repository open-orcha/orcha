import SwiftUI

/// One agent's spend drilldown (web Metrics › agent):
/// `GET …/metrics/agents/{aid}/spend?window=` — cost / total tokens / runs, the token
/// mix, that agent's monthly budget, the insights that concern it, and spend by task.
struct UsageSpendScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let route: UsageAgentRoute
    let catalog: [ModelDto]

    @State private var window: String
    @State private var data: AgentSpendDto?
    @State private var loadError: String?
    @State private var budgets: ProjectBudgetsDto?
    @State private var insights: [InsightDto]?
    @State private var insightsError: String?

    init(route: UsageAgentRoute, catalog: [ModelDto]) {
        self.route = route
        self.catalog = catalog
        _window = State(initialValue: route.window)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                LSegmented(UsageUx.spendWindows.map { ($0.key, $0.label) }, selection: $window)
                header
                content
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle(route.alias)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: window) { await load() }
    }

    private var header: some View {
        let modelId = data?.agent.model ?? route.model
        let name = UsageUx.modelName(modelId, catalog: catalog)
        return HStack(spacing: LSpace.s) {
            LAvatar(name: route.alias, isAI: true, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(route.alias).ltype(.headline).foregroundStyle(p.text)
                HStack(spacing: 4) {
                    ModelProviderMark(model: modelId, size: 12)
                    Text(name ?? "Model not recorded").ltype(.meta).foregroundStyle(name == nil ? p.faint : p.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var content: some View {
        if let data {
            totals(data.totals)
            if let budgets { UsageBudgetsSection(budgets: budgets, agentId: route.agentId) }
            UsageInsightsSection(
                insights: insights.map {
                    UsageUx.insightsForAgent($0, agentId: route.agentId, alias: route.alias, taskIds: data.tasks.map(\.taskId))
                },
                error: insightsError,
                scope: UsageUx.insightsWindow(for: window) == "7d" && window != "7d" ? "last 7 days" : nil,
                emptyText: "No suggestions for \(route.alias) in this window.",
                retry: { Task { await loadInsights() } }
            )
            tasks(data)
        } else if let loadError {
            LEmptyState(icon: "exclamationmark.triangle", title: "Spend detail is temporarily unavailable",
                        message: loadError, actionTitle: "Retry") { Task { await load() } }
        } else {
            LCard { UsageSkeleton(rows: 5) }
        }
    }

    @ViewBuilder
    private func totals(_ t: TokenMixDto) -> some View {
        let state = UsageUx.spendCostState(t)
        let unknown = t.runs > 0 && state == .none
        UsageTileGrid {
            UsageStatTile(label: "Cost (USD)", value: unknown ? "Not reported" : UsageUx.usd(t.totalCostUsd),
                          sub: UsageUx.spendCostCaption(t)?.replacingOccurrences(of: " reported cost", with: ""),
                          unknown: unknown)
            UsageStatTile(label: "Total tokens", value: UsageUx.tokens(t.totalTokens), sub: "the quota signal")
            UsageStatTile(label: "Runs", value: "\(t.runs)", sub: "measured")
            UsageStatTile(label: "Cache hit", value: UsageUx.cacheHitPct(t).map { "\($0.formatted())%" } ?? "n/a",
                          sub: "reads ÷ (input + reads)", unknown: UsageUx.cacheHitPct(t) == nil)
        }
        if t.totalTokens > 0 {
            LCard {
                VStack(alignment: .leading, spacing: LSpace.s) {
                    Text("Token mix").ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2)
                    UsageTokenMix(mix: t)
                    Text(UsageUx.cacheNote).ltype(.micro).foregroundStyle(p.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func tasks(_ data: AgentSpendDto) -> some View {
        LSection("Spend by task", count: data.tasks.count) {
            if data.tasks.isEmpty {
                Text("No measured runs in this window.").ltype(.meta).foregroundStyle(p.muted)
            } else {
                let top = Double(data.tasks.map(\.mix.totalTokens).max() ?? 1)
                LCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(data.tasks) { task in
                            UsageSpendTaskRow(task: task, bar: Double(task.mix.totalTokens) / max(top, 1))
                            if task.id != data.tasks.last?.id { LDivider(inset: LSpace.m) }
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        async let spend = model.api.agentSpend(sel.baseUrl, sel.id, agentId: route.agentId, window: window)
        async let budgetsReq = try? model.api.projectBudgets(sel.baseUrl, sel.id)
        async let insightsLoad: Void = loadInsights()
        do {
            data = try await spend
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            data = nil
            loadError = UsageUx.describe(error)
        }
        budgets = await budgetsReq
        _ = await insightsLoad
    }

    private func loadInsights() async {
        guard let sel = model.selectedContainer else { return }
        do {
            insights = try await model.api.metricsInsights(sel.baseUrl, sel.id, window: UsageUx.insightsWindow(for: window)).insights
            insightsError = nil
        } catch {
            insightsError = UsageUx.describe(error)
        }
    }
}

private struct UsageSpendTaskRow: View {
    @Environment(\.palette) private var p
    let task: SpendTaskDto
    let bar: Double

    var body: some View {
        let m = task.mix
        let title = task.title ?? (task.taskId == nil ? "Conversation (no task)" : "Untitled task")
        let state = UsageUx.spendCostState(m)
        let cost = state == .none ? "not reported" : UsageUx.usd(m.totalCostUsd) + (state == .partial ? " · partial" : "")
        let hit = UsageUx.cacheHitPct(m).map { "\($0.formatted())% cache hit" } ?? "cache hit n/a"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: LSpace.s) {
                if let status = task.status {
                    LStatusGlyph(status: status, size: 13)
                } else {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 11))
                        .foregroundStyle(p.faint)
                        .accessibilityHidden(true)
                }
                Text(title).ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(2)
                Spacer(minLength: LSpace.s)
                Text(UsageUx.tokens(m.totalTokens)).ltype(.meta).monospacedDigit().foregroundStyle(p.text)
            }
            UsageShareBar(fraction: bar)
            HStack {
                Text("\(UsageUx.plural(m.runs, "run")) · \(UsageUx.tokens(m.inputTokens)) in · \(UsageUx.tokens(m.outputTokens)) out · \(hit)")
                    .lineLimit(2)
                Spacer(minLength: LSpace.s)
                Text(cost)
            }
            .ltype(.micro).monospacedDigit().foregroundStyle(p.muted)
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)\(task.status.map { ", " + LStatusGlyph.label(for: $0) } ?? ""), \(UsageUx.tokens(m.totalTokens)) tokens, \(UsageUx.plural(m.runs, "run")), \(hit), cost \(cost)")
    }
}
