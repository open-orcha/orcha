package io.openorcha.mobile.ui.screens

/* Agent spend drilldown (web MetricsPage SpendDrawer): window pills (5 hours · 7 days ·
   30 days · All time), cost / total tokens / runs, token mix, spend by task as a Canvas
   bar chart, the agent's budget meters and the insights that concern this agent.
   GET .../metrics/agents/{aid}/spend?window= and .../metrics/insights?window=. */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentSpendResponse
import io.openorcha.mobile.data.ProjectBudgetsResponse
import io.openorcha.mobile.data.SpendInsightDto
import io.openorcha.mobile.data.SpendTaskDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.UsageApi
import io.openorcha.mobile.domain.UsageFormat
import io.openorcha.mobile.domain.UsageFormat.plural
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ModelProviderMark
import io.openorcha.mobile.ui.components.lStatusLabel
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UsageAgentSpendSheet(
    container: StoredContainer,
    agentId: String,
    alias: String?,
    initialWindow: String,
    modelName: String?,
    budgets: ProjectBudgetsResponse?,
    onDismiss: () -> Unit,
) {
    val p = Orcha.palette
    var window by remember { mutableStateOf(initialWindow) }
    var data by remember { mutableStateOf<AgentSpendResponse?>(null) }
    var insights by remember { mutableStateOf<List<SpendInsightDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(agentId, window, reload) {
        error = null
        data = null
        runCatching { UsageApi.agentSpend(container.baseUrl, container.id, agentId, window) }
            .onSuccess { data = it }
            .onFailure { error = routineErrorText(it) }
    }
    LaunchedEffect(agentId, UsageFormat.insightsWindowFor(window), reload) {
        insights = runCatching { UsageApi.insights(container.baseUrl, container.id, UsageFormat.insightsWindowFor(window)).insights }
            .getOrNull()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = Modifier.statusBarsPadding(),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        LazyColumn(
            contentPadding = PaddingValues(start = LSpace.l, end = LSpace.l, bottom = LSpace.xl),
            verticalArrangement = Arrangement.spacedBy(LSpace.l),
        ) {
            item {
                val name = alias ?: data?.agent?.alias ?: "Agent"
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    LAvatar(name, isAI = true, size = 32.dp)
                    Column(Modifier.weight(1f)) {
                        Text(name, style = ltype(LType.Title), color = p.text)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            ModelProviderMark(data?.agent?.model, size = 12.dp, decorative = true)
                            Text(modelName ?: UsageFormat.MODEL_UNKNOWN, style = ltype(LType.Meta), color = p.muted)
                        }
                    }
                }
            }
            item { LSegmented(UsageFormat.SPEND_WINDOWS, window, { window = it }) }
            val d = data
            when {
                d == null && error != null -> item {
                    LEmptyState(OrchaIcons.WarningAmber, "Spend detail is unavailable", error!!.replaceFirstChar { it.uppercase() } + ".",
                        actionTitle = "Retry", onAction = { reload++ })
                }
                d == null -> item { UsageSkeleton() }
                d.totals.runs == 0 -> item {
                    LEmptyState(OrchaIcons.Schedule, "No measured runs in this window", "Pick a longer window to see this agent's spend.")
                }
                else -> {
                    item { SpendTotals(d) }
                    item { LCard { TokenMix(d.totals) } }
                    item { SpendByTask(d.tasks) }
                }
            }
            budgets?.let { b -> item { UsageBudgetBars(b, onlyAgentId = agentId) } }
            val mine = insights?.let { all -> UsageFormat.insightsForAgent(all, agentId, alias, d?.tasks.orEmpty().map { it.taskId }) }
            if (!mine.isNullOrEmpty()) {
                item {
                    LSection("How to reduce spending", count = mine.size) {
                        LCard {
                            mine.forEachIndexed { i, ins ->
                                if (i > 0) LDivider(Modifier.padding(vertical = LSpace.s))
                                InsightRow(ins)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SpendTotals(d: AgentSpendResponse) {
    val t = d.totals
    val st = UsageFormat.spendCostState(t.runs, t.totalCostUsd, t.runsWithCost)
    val sub = when (st) {
        "none" -> "no run reported a cost"
        "partial" -> t.runsWithCost?.let { "partial · $it of ${t.runs} runs" } ?: "partial"
        else -> null
    }
    LCard {
        Row(horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
            UsageStatTile("Cost (USD)", if (st == "none") "Not reported" else UsageFormat.usd(t.totalCostUsd), sub, Modifier.weight(1f), st == "none")
            UsageStatTile("Total tokens", UsageFormat.tokens(t.totalTokens), null, Modifier.weight(1f))
            UsageStatTile("Runs", t.runs.toString(), null, Modifier.weight(1f))
        }
    }
}

/** Spend by task: a Canvas horizontal bar per task (tokens), with the dollar figure. */
@Composable
private fun SpendByTask(tasks: List<SpendTaskDto>) {
    val p = Orcha.palette
    val rows = tasks.sortedByDescending { it.totalTokens }
    val max = rows.maxOfOrNull { it.totalTokens }?.coerceAtLeast(1) ?: 1
    LSection("By task", count = rows.size) {
        LCard {
            rows.forEachIndexed { i, r ->
                if (i > 0) LDivider(Modifier.padding(vertical = LSpace.s))
                val title = r.title?.takeIf { it.isNotBlank() } ?: "Chat & inbox (no task)"
                val cost = UsageFormat.spendCostText(r.runs, r.totalCostUsd, r.runsWithCost)
                val status = r.status?.let { lStatusLabel(it) }
                Column(
                    Modifier.semantics(mergeDescendants = true) {
                        contentDescription = "$title${status?.let { ", $it" } ?: ""}. ${UsageFormat.tokens(r.totalTokens)} tokens, " +
                            "$cost, ${plural(r.runs, "run")}."
                    },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                        r.status?.let { LStatusGlyph(it) }
                        Text(title, style = ltype(LType.Body), color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(cost, style = ltype(LType.Meta), color = if (cost == UsageFormat.NOT_REPORTED) p.muted else p.text)
                    }
                    val bar = p.accent
                    val track = p.surface3
                    val frac = r.totalTokens.toFloat() / max
                    Canvas(Modifier.fillMaxWidth().height(6.dp)) {
                        val rad = CornerRadius(3.dp.toPx())
                        drawRoundRect(track, Offset.Zero, size, rad)
                        drawRoundRect(bar, Offset.Zero, Size((size.width * frac).coerceAtLeast(2.dp.toPx()), size.height), rad)
                    }
                    Text(
                        "${UsageFormat.tokens(r.totalTokens)} tokens · ${plural(r.runs, "run")} · " +
                            "${UsageFormat.tokens(r.cacheReadInputTokens + r.cacheCreationInputTokens)} cached",
                        style = ltype(LType.Micro), color = p.muted,
                    )
                }
            }
        }
    }
}

@Composable
private fun InsightRow(i: SpendInsightDto) {
    val p = Orcha.palette
    val tone = when (i.severity) { "high" -> p.danger; "medium" -> p.warn; else -> p.muted }
    Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            LTag(UsageFormat.severityLabel(i.severity), tint = tone)
            Text(i.title, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
        }
        if (i.detail.isNotBlank()) Text(i.detail, style = ltype(LType.Meta), color = p.text2)
        val chips = UsageFormat.evidenceChips(i)
        if (chips.isNotEmpty()) Text(chips.joinToString(" · "), style = ltype(LType.Micro), color = p.muted)
        if (i.action.isNotBlank()) Text(i.action, style = ltype(LType.Meta), color = p.text2)
    }
}
