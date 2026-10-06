package io.openorcha.mobile.ui.screens

/* Metrics & usage (web cloud/metrics/MetricsPage): range pills (7 / 30 days) over the one
   aggregate GET /metrics?days=, summary tiles, runs per UTC day, cost & activity by agent
   (tap → spend drilldown sheet), agent performance (verified throughput, first pass,
   rework — GET /metrics/performance?range=), token usage (5h / 7d / all, quota, token mix,
   latest wake) and budget meters. Pull to refresh. Open from the workspace ⋯. */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.PerfBucketDto
import io.openorcha.mobile.data.PerfRowDto
import io.openorcha.mobile.data.PerformanceResponse
import io.openorcha.mobile.data.ProjectApi
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.MetricsFormat
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.layout.Spacer
import io.openorcha.mobile.data.MetricsSummaryResponse
import io.openorcha.mobile.data.MxAgentDto
import io.openorcha.mobile.data.ProjectBudgetsResponse
import io.openorcha.mobile.data.TokenUsageResponse
import io.openorcha.mobile.data.UsageApi
import io.openorcha.mobile.domain.UsageFormat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectMetricsScreen(container: StoredContainer, onBack: () -> Unit) {
    val p = Orcha.palette
    var days by remember { mutableIntStateOf(7) }
    var range by remember { mutableStateOf("7d") }
    var tokenWindow by remember { mutableStateOf("7d") }
    var summary by remember { mutableStateOf<MetricsSummaryResponse?>(null) }
    var summaryError by remember { mutableStateOf<String?>(null) }
    var perf by remember { mutableStateOf<PerformanceResponse?>(null) }
    var perfError by remember { mutableStateOf<String?>(null) }
    var usage by remember { mutableStateOf<TokenUsageResponse?>(null) }
    var budgets by remember { mutableStateOf<ProjectBudgetsResponse?>(null) }
    var catalog by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var reload by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    var drill by remember { mutableStateOf<MxAgentDto?>(null) }

    LaunchedEffect(container.id, days, reload) {
        summaryError = null
        runCatching { UsageApi.summary(container.baseUrl, container.id, days) }
            .onSuccess { summary = it }
            .onFailure { summaryError = routineErrorText(it) }
        refreshing = false
    }
    LaunchedEffect(container.id, range, reload) {
        perfError = null
        runCatching { ProjectApi.performance(container.baseUrl, container.id, range) }
            .onSuccess { perf = it }
            .onFailure { perfError = routineErrorText(it) }
    }
    LaunchedEffect(container.id, reload) {
        runCatching { UsageApi.tokenUsage(container.baseUrl, container.id) }.onSuccess { usage = it }
        runCatching { ProjectApi.budgets(container.baseUrl, container.id) }.onSuccess { budgets = it }
    }
    LaunchedEffect(container.baseUrl) {
        runCatching { UsageApi.models(container.baseUrl) }
            .onSuccess { r -> catalog = r.models.mapNotNull { m -> m.name?.let { m.id to it } }.toMap() }
    }

    Scaffold(containerColor = p.bg, topBar = { LTopBar(title = "Metrics", onBack = onBack) }) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; reload++ },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(LSpace.l),
                verticalArrangement = Arrangement.spacedBy(LSpace.xl),
            ) {
                item {
                    LSegmented(options = UsageFormat.SUMMARY_WINDOWS, selection = days, onSelect = { days = it; summary = null })
                }
                val s = summary
                when {
                    s == null && summaryError != null -> item {
                        LEmptyState(
                            OrchaIcons.WarningAmber, "Metrics are temporarily unavailable",
                            "Couldn't reach the metrics service. Your data is unaffected.\n" +
                                summaryError!!.replaceFirstChar { it.uppercase() } + ".",
                            actionTitle = "Retry", onAction = { reload++ },
                        )
                    }
                    s == null -> item { UsageSkeleton() }
                    s.totals.runs == 0 -> item {
                        LEmptyState(OrchaIcons.Schedule, "No agent runs in the last ${s.days} days", "Figures appear once agents wake and record usage.")
                    }
                    else -> {
                        item { UsageSummaryCard(s) }
                        item { AgentCostSection(s, catalog) { drill = it } }
                    }
                }
                item {
                    PerformanceSection(range, { range = it }, perf, perfError) { reload++ }
                }
                item {
                    val u = usage
                    TokenUsageSection(tokenWindow, { tokenWindow = it }, u?.windows?.get(tokenWindow), u?.lastWake)
                }
                budgets?.let { b -> item { UsageBudgetBars(b) } }
            }
        }
    }

    drill?.let { a ->
        UsageAgentSpendSheet(
            container = container,
            agentId = a.agentId,
            alias = a.alias,
            initialWindow = if (days == 30) "30d" else "7d",
            modelName = UsageFormat.modelName(a.model, catalog),
            budgets = budgets,
            onDismiss = { drill = null },
        )
    }
}

@Composable
private fun AgentCostSection(s: MetricsSummaryResponse, catalog: Map<String, String>, onSelect: (MxAgentDto) -> Unit) {
    val unreported = UsageFormat.costUnreported(s.totals)
    val complete = UsageFormat.costComplete(s.totals)
    val rows = UsageFormat.sortAgents(s.perAgent, byTokens = unreported)
    val maxCost = rows.maxOfOrNull { it.estCostUsd } ?: 0.0
    LSection("Cost & activity by agent", count = rows.size) {
        LCard(padding = 10.dp) {
            rows.forEachIndexed { i, a ->
                if (i > 0) LDivider(Modifier.padding(vertical = 4.dp))
                UsageAgentRow(
                    a = a,
                    modelName = UsageFormat.modelName(a.model, catalog),
                    costText = UsageFormat.usdOrNotReported(a.estCostUsd, complete),
                    barFraction = UsageFormat.costBarFraction(a.estCostUsd, maxCost, complete),
                    onClick = { onSelect(a) },
                )
            }
        }
    }
}

@Composable
private fun PerformanceSection(
    range: String,
    onRange: (String) -> Unit,
    d: PerformanceResponse?,
    error: String?,
    onRetry: () -> Unit,
) {
    val p = Orcha.palette
    LSection("Agent performance", count = d?.agents?.size) {
        LSegmented(options = MetricsFormat.RANGES, selection = range, onSelect = onRange)
        when {
            d == null && error != null -> LEmptyState(
                OrchaIcons.WarningAmber, "Couldn't load performance", error.replaceFirstChar { it.uppercase() } + ".",
                actionTitle = "Retry", onAction = onRetry,
            )
            d == null -> Text("Loading performance…", style = ltype(LType.Meta), color = p.muted)
            else -> {
                ProjectCards(d.project)
                Spacer(Modifier.height(LSpace.xs))
                if (d.agents.isEmpty()) {
                    Text("No agent activity in this range.", style = ltype(LType.Meta), color = p.muted)
                } else LCard {
                    d.agents.forEachIndexed { i, a ->
                        if (i > 0) LDivider(Modifier.padding(vertical = LSpace.s))
                        AgentPerfRow(a)
                    }
                }
                Text(
                    "Rates need at least ${d.minSample} decisions before they show. Cost covers metered tasks only.",
                    style = ltype(LType.Micro), color = p.muted,
                )
            }
        }
    }
}

@Composable
private fun ProjectCards(row: PerfRowDto) {
    val p = Orcha.palette
    val m = row.metrics
    run {
        LCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
                Column(Modifier.weight(1f)) {
                    Text("All agents · verified", style = ltype(LType.Meta), color = p.muted)
                    Text(m.tasksVerified.toString(), style = ltype(LType.Title), color = p.text)
                }
                Sparkline(row.series, p.accent, Modifier.width(140.dp).height(36.dp), "Verified tasks per day")
            }
            LDivider(Modifier.padding(vertical = LSpace.s))
            Stat("First pass", MetricsFormat.rate(m.firstPassRate))
            Stat("Time to verified", MetricsFormat.duration(m.medianTimeToVerified))
            Stat("Rework", m.rework.total.toString())
            Stat("Cost / verified", MetricsFormat.cost(m.costPerVerified))
            Stat("Plan approval", MetricsFormat.rate(m.planApprovalRate))
            Stat("Escalations", m.escalations.toString())
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    val p = Orcha.palette
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, style = ltype(LType.Body), color = p.text2, modifier = Modifier.weight(1f))
        Text(value, style = ltype(LType.BodyEmph), color = if (value == MetricsFormat.NOT_ENOUGH || value == MetricsFormat.NOT_METERED) p.muted else p.text)
    }
}

@Composable
private fun AgentPerfRow(a: PerfRowDto) {
    val p = Orcha.palette
    val m = a.metrics
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Text(
                (a.alias ?: "Agent") + if (a.retired) " (retired)" else "",
                style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f),
            )
            Sparkline(a.series, p.accent, Modifier.width(96.dp).height(24.dp), "Verified tasks per day for ${a.alias ?: "this agent"}")
        }
        Text(
            "${m.tasksVerified} verified · First pass ${MetricsFormat.rate(m.firstPassRate)} · " +
                "${MetricsFormat.duration(m.medianTimeToVerified)} to verify · ${m.rework.total} rework",
            style = ltype(LType.Meta), color = p.text2,
        )
    }
}

/** Simple bar sparkline of verified tasks per bucket (rework stacked in a muted tone). */
@Composable
private fun Sparkline(series: List<PerfBucketDto>, color: Color, modifier: Modifier, label: String) {
    val faint = Orcha.palette.border2
    val danger = Orcha.palette.warn
    val total = series.sumOf { it.verified }
    Canvas(modifier.semantics { contentDescription = "$label: $total in total" }) {
        if (series.isEmpty()) return@Canvas
        val max = (series.maxOf { it.verified + it.rework }).coerceAtLeast(1)
        val gap = 2.dp.toPx()
        val w = ((size.width - gap * (series.size - 1)) / series.size).coerceAtLeast(1f)
        series.forEachIndexed { i, b ->
            val x = i * (w + gap)
            val vh = size.height * b.verified / max
            val rh = size.height * b.rework / max
            if (b.verified == 0 && b.rework == 0) {
                drawRect(faint, Offset(x, size.height - 1.dp.toPx()), Size(w, 1.dp.toPx()))
            }
            if (vh > 0) drawRoundRect(color, Offset(x, size.height - vh), Size(w, vh), CornerRadius(1.5f, 1.5f))
            if (rh > 0) drawRoundRect(danger, Offset(x, size.height - vh - rh), Size(w, rh), CornerRadius(1.5f, 1.5f))
        }
    }
}
