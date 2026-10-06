import Charts
import SwiftUI

/// Metrics — mirrors the web Metrics page top to bottom:
/// 1. 7 / 30 day pills + "How cost is estimated" (`GET …/metrics?days=`);
/// 2. summary figures and runs per UTC day; 3. cost & activity by agent (tap → spend
/// drilldown, `…/metrics/agents/{aid}/spend`); 4. agent performance with its own range
/// pills (`…/metrics/performance`); 5. monthly budgets (`…/budgets`); 6. how to reduce
/// spending (`…/metrics/insights`); 7. token usage vs quota (`…/token-usage`).
/// Figures are never made up: an unreported cost reads "Not reported", never $0.
struct MetricsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss

    @State private var days = 7
    @State private var summary: MetricsSummaryDto?
    @State private var summaryError: String?
    @State private var catalog: [ModelDto] = []
    @State private var budgets: ProjectBudgetsDto?
    @State private var insights: [InsightDto]?
    @State private var insightsError: String?
    @State private var tokenUsage: TokenUsageDto?
    @State private var tokenError: String?

    @State private var range = "7d"
    @State private var data: PerformanceDto?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                ScrollView {
                    VStack(alignment: .leading, spacing: LSpace.xl) {
                        VStack(alignment: .leading, spacing: LSpace.m) {
                            HStack(spacing: LSpace.s) {
                                LSegmented(UsageUx.summaryRanges.map { ($0.key, $0.label) }, selection: $days)
                                UsageCostInfoButton(scope: scopeLine)
                            }
                            Text(scopeLine).ltype(.micro).foregroundStyle(p.faint)
                            summaryContent
                        }
                        performanceSection
                        if let budgets { UsageBudgetsSection(budgets: budgets) }
                        UsageInsightsSection(insights: insights, error: insightsError,
                                             retry: { Task { await loadInsights() } })
                        UsageTokenSection(usage: tokenUsage, error: tokenError,
                                          retry: { Task { await loadTokenUsage() } })
                    }
                    .padding(.horizontal, LSpace.l)
                    .padding(.vertical, LSpace.m)
                }
                .background(p.bg)
                .refreshable { await reloadAll() }
            }
            .navigationTitle("Metrics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(p.bg, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
            }
            .navigationDestination(for: PerfAgentRowDto.self) { agent in
                OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                    AgentMetricsScreen(agentId: agent.agentId, alias: agent.alias, range: range)
                }
            }
            .navigationDestination(for: UsageAgentRoute.self) { route in
                OrchaThemed(mode: model.themeMode, skin: model.skinMode) {
                    UsageSpendScreen(route: route, catalog: catalog)
                }
            }
        }
        .task(id: days) { await loadSummarySide() }
        .task(id: range) { await load() }
        .task { await loadOnce() }
    }

    private var scopeLine: String {
        let name = model.selectedContainer?.displayName ?? "This project"
        return "\(name) · all agents with runs · last \(summary?.days ?? days) days (UTC calendar days)"
    }

    // MARK: summary + agents

    @ViewBuilder
    private var summaryContent: some View {
        if let summaryError {
            LEmptyState(icon: "exclamationmark.triangle", title: "Metrics are temporarily unavailable",
                        message: "Couldn’t reach the metrics service. Your data is unaffected. \(summaryError)",
                        actionTitle: "Retry") { Task { await loadSummarySide() } }
        } else if let summary {
            if summary.totals.runs == 0 {
                LEmptyState(icon: "chart.bar", title: "No agent runs in the last \(summary.days) days",
                            message: "Figures appear once agents wake and record usage.")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, LSpace.l)
            } else {
                UsageSummarySection(data: summary)
                UsageAgentsSection(data: summary, catalog: catalog, window: UsageUx.spendWindow(forDays: summary.days))
                    .padding(.top, LSpace.m)
            }
        } else {
            UsageTileGrid {
                ForEach(0..<4, id: \.self) { _ in LCard { UsageSkeleton(rows: 2) } }
            }
            LCard { UsageSkeleton(rows: 4) }
        }
    }

    // MARK: performance

    private var performanceSection: some View {
        let agents = (data?.agents ?? []).filter { !$0.retired || $0.metrics.tasksVerified > 0 }
        return LSection("Agent performance", count: data == nil ? nil : agents.count) {
            VStack(alignment: .leading, spacing: LSpace.m) {
                LSegmented(PerfUx.ranges.map { ($0.key, $0.label) }, selection: $range)
                if let data {
                    MetricsFigures(metrics: data.project.metrics)
                    if !data.project.series.isEmpty {
                        LCard {
                            VStack(alignment: .leading, spacing: LSpace.s) {
                                Text("Verified and rework").ltype(.meta).fontWeight(.medium).foregroundStyle(p.text2)
                                PerfBars(series: data.project.series)
                            }
                        }
                    }
                    LCard(padding: 0) {
                        VStack(spacing: 0) {
                            allAgentsRow(data)
                            ForEach(agents) { agent in
                                LDivider(inset: LSpace.m)
                                NavigationLink(value: agent) { AgentPerfRow(agent: agent) }
                                    .buttonStyle(.lRow)
                            }
                        }
                    }
                    definitions
                } else if let loadError {
                    LCard { UsageInlineError(text: "Couldn't load performance. \(loadError)", retry: { Task { await load() } }) }
                } else {
                    LCard { UsageSkeleton(rows: 4) }
                }
            }
        }
    }

    private func allAgentsRow(_ data: PerformanceDto) -> some View {
        let m = data.project.metrics
        let fp = PerfUx.firstPass(m)
        let md = PerfUx.median(m)
        return LRow(
            title: "All agents",
            subtitle: "\(m.tasksVerified) verified · first pass \(fp.known ? fp.text : "—") · \(md.known ? md.text : "—") to verified"
        ) {
            Image(systemName: "person.3")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(p.muted)
                .frame(width: 26, height: 26)
                .background(p.surface2, in: Circle())
                .accessibilityHidden(true)
        } trailing: {
            EmptyView()
        }
        .accessibilityElement(children: .combine)
    }

    private var definitions: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: LSpace.s) {
                ForEach(PerfUx.definitions, id: \.term) { item in
                    (Text(item.term + " — ").bold() + Text(item.meaning))
                        .ltype(.meta)
                        .foregroundStyle(p.text2)
                }
            }
            .padding(.top, LSpace.s)
        } label: {
            Text("What these mean").ltype(.meta).foregroundStyle(p.muted)
        }
        .tint(p.muted)
        .padding(.horizontal, 4)
    }

    // MARK: loading

    private func reloadAll() async {
        async let a: Void = loadSummarySide()
        async let b: Void = load()
        async let c: Void = loadTokenUsage()
        _ = await (a, b, c)
    }

    /// Once per appearance: the model catalog (names only) and the token meter.
    private func loadOnce() async {
        guard let sel = model.selectedContainer else { return }
        async let meter: Void = loadTokenUsage()
        if catalog.isEmpty, let models = try? await model.api.models(sel.baseUrl) {
            catalog = models.models
        }
        _ = await meter
    }

    /// The day-range driven reads: aggregate, budgets and insights.
    private func loadSummarySide() async {
        guard let sel = model.selectedContainer else { return }
        async let budgetsReq = try? model.api.projectBudgets(sel.baseUrl, sel.id)
        async let insightsLoad: Void = loadInsights()
        do {
            summary = try await model.api.metricsSummary(sel.baseUrl, sel.id, days: days)
            summaryError = nil
        } catch is CancellationError {
        } catch {
            summary = nil
            summaryError = UsageUx.describe(error)
        }
        budgets = await budgetsReq
        _ = await insightsLoad
    }

    private func loadInsights() async {
        guard let sel = model.selectedContainer else { return }
        do {
            insights = try await model.api.metricsInsights(sel.baseUrl, sel.id, window: days == 30 ? "all" : "7d").insights
            insightsError = nil
        } catch is CancellationError {
        } catch {
            insightsError = UsageUx.describe(error)
        }
    }

    private func loadTokenUsage() async {
        guard let sel = model.selectedContainer else { return }
        do {
            tokenUsage = try await model.api.tokenUsage(sel.baseUrl, sel.id)
            tokenError = nil
        } catch is CancellationError {
        } catch {
            tokenError = UsageUx.describe(error)
        }
    }

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        do {
            data = try await model.api.performance(sel.baseUrl, sel.id, range: range)
            loadError = nil
        } catch is CancellationError {
        } catch {
            data = nil
            loadError = UsageUx.describe(error)
        }
    }
}

extension PerfAgentRowDto: Hashable {
    func hash(into hasher: inout Hasher) { hasher.combine(agentId) }
}

/// The figure cards, two per row.
struct MetricsFigures: View {
    @Environment(\.palette) private var p
    let metrics: PerfMetricsDto

    var body: some View {
        let fp = PerfUx.firstPass(metrics)
        let md = PerfUx.median(metrics)
        let cost = PerfUx.costPerVerified(metrics)
        let plan = PerfUx.planApproval(metrics)
        LazyVGrid(columns: [GridItem(.flexible(), spacing: LSpace.s), GridItem(.flexible(), spacing: LSpace.s)], spacing: LSpace.s) {
            FigureCard(title: "Verified", value: "\(metrics.tasksVerified)", sub: "tasks", known: true)
            FigureCard(title: "First pass", value: fp.text, sub: fp.sub, known: fp.known, tint: tone)
            FigureCard(title: "Rework", value: "\(metrics.rework.total)", sub: PerfUx.rework(metrics), known: true)
            FigureCard(title: "Time to verified", value: md.text, sub: md.sub, known: md.known)
            FigureCard(title: "Cost / verified", value: cost.text, sub: cost.sub, known: cost.known)
            FigureCard(title: "Plan approval", value: plan.text, sub: plan.sub, known: plan.known)
            FigureCard(title: "Escalations", value: "\(metrics.escalations)", sub: "asks sent to a human", known: true)
        }
    }

    private var tone: Color? {
        switch PerfUx.firstPassTone(metrics) {
        case .good: p.ok
        case .warn: p.warn
        case .bad: p.danger
        case nil: nil
        }
    }
}

private struct FigureCard: View {
    @Environment(\.palette) private var p
    let title: String
    let value: String
    let sub: String
    let known: Bool
    var tint: Color?

    var body: some View {
        LCard {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).ltype(.micro).foregroundStyle(p.muted)
                Text(value)
                    .ltype(known ? .title : .meta)
                    .foregroundStyle(known ? (tint ?? p.text) : p.faint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(sub).ltype(.micro).foregroundStyle(p.faint).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Verified (and rework) per bucket — a small Swift Charts bar chart.
struct PerfBars: View {
    @Environment(\.palette) private var p
    let series: [PerfBucketDto]

    var body: some View {
        Chart(series) { bucket in
            let date = MobileUx.parseInstant(bucket.start) ?? .now
            BarMark(x: .value("Day", date, unit: .day), y: .value("Verified", bucket.verified))
                .foregroundStyle(by: .value("Kind", "Verified"))
            if bucket.rework > 0 {
                BarMark(x: .value("Day", date, unit: .day), y: .value("Rework", bucket.rework))
                    .foregroundStyle(by: .value("Kind", "Rework"))
            }
        }
        .chartForegroundStyleScale(["Verified": p.accent, "Rework": p.warn])
        .chartLegend(position: .bottom, alignment: .leading)
        .frame(height: 140)
        .accessibilityLabel("Verified and rework per period")
        .accessibilityValue("\(series.reduce(0) { $0 + $1.verified }) verified, \(series.reduce(0) { $0 + $1.rework }) rework")
    }
}

struct AgentPerfRow: View {
    @Environment(\.palette) private var p
    let agent: PerfAgentRowDto

    var body: some View {
        let fp = PerfUx.firstPass(agent.metrics)
        let md = PerfUx.median(agent.metrics)
        LRow(
            title: agent.alias + (agent.retired ? " (retired)" : ""),
            subtitle: "\(agent.metrics.tasksVerified) verified · first pass \(fp.known ? fp.text : "—") · \(md.known ? md.text : "—") to verified"
        ) {
            LAvatar(name: agent.alias, isAI: true, size: 26)
        } trailing: {
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(p.faint)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One agent's performance (`…/metrics/performance/agents/{aid}`).
struct AgentMetricsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String
    let alias: String
    @State var range: String

    @State private var data: AgentPerformanceDto?
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LSpace.l) {
                LSegmented(PerfUx.ranges.map { ($0.key, $0.label) }, selection: $range)
                if let data {
                    if let role = data.agent.role ?? data.agent.model {
                        HStack(spacing: 5) {
                            ModelProviderMark(model: data.agent.model, size: 12)
                            Text(role).ltype(.meta).foregroundStyle(p.muted)
                        }
                    }
                    MetricsFigures(metrics: data.agent.metrics)
                    if !data.agent.series.isEmpty {
                        LSection("Verified and rework") {
                            LCard { PerfBars(series: data.agent.series) }
                        }
                    }
                } else if let loadError {
                    LEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load metrics", message: loadError, actionTitle: "Try again") {
                        Task { await load() }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, LSpace.xl)
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .background(p.bg)
        .navigationTitle(alias)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: range) { await load() }
    }

    private func load() async {
        guard let sel = model.selectedContainer else { return }
        do {
            data = try await model.api.agentPerformance(sel.baseUrl, sel.id, agentId: agentId, range: range)
            loadError = nil
        } catch {
            loadError = InboxErrorText.describe(error)
        }
    }
}
