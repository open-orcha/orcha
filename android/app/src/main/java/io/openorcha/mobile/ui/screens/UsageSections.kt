package io.openorcha.mobile.ui.screens

/* Metrics & usage building blocks (web cloud/metrics/MetricsPage + BudgetBars): summary
   tiles, runs-per-day bars, cost & activity by agent, token usage (window, quota ring,
   token mix, latest wake) and budget meters. Pure presentation — the screen loads data. */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.BudgetStatusDto
import io.openorcha.mobile.data.LastWakeDto
import io.openorcha.mobile.data.MetricsSummaryResponse
import io.openorcha.mobile.data.MxAgentDto
import io.openorcha.mobile.data.ProjectBudgetsResponse
import io.openorcha.mobile.data.TokenWindowDto
import io.openorcha.mobile.domain.RunHealth
import io.openorcha.mobile.domain.UsageFormat
import io.openorcha.mobile.domain.UsageFormat.plural
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ModelProviderMark
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.OrchaPalette

// ── summary ──

/** One summary tile: muted label, figure, one-line caption. */
@Composable
internal fun UsageStatTile(label: String, value: String, sub: String?, modifier: Modifier = Modifier, unknown: Boolean = false) {
    val p = Orcha.palette
    Column(
        modifier.semantics(mergeDescendants = true) {}.padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label, style = ltype(LType.Micro), color = p.muted, maxLines = 2)
        Text(value, style = ltype(LType.Headline), color = if (unknown) p.muted else p.text)
        if (sub != null) Text(sub, style = ltype(LType.Micro), color = p.muted)
    }
}

/** Two-column grid of the web's five summary figures. */
@Composable
internal fun UsageSummaryCard(d: MetricsSummaryResponse) {
    val t = d.totals
    val unreported = UsageFormat.costUnreported(t)
    val agents = d.perAgent.size
    val tiles: List<@Composable (Modifier) -> Unit> = listOf(
        { m -> UsageStatTile("Est. cost (USD)", if (unreported) "Not reported" else UsageFormat.usd(t.estCostUsd), UsageFormat.costCaptionShort(t), m, unreported) },
        { m -> UsageStatTile("Runs", t.runs.toString(), if (agents > 0) "across ${plural(agents, "agent")}" else null, m) },
        { m -> UsageStatTile("Tokens (in · out)", UsageFormat.tokens(t.tokensIn) + " · " + UsageFormat.tokens(t.tokensOut), "excl. cache", m) },
        { m -> UsageStatTile("Sandbox compute", UsageFormat.duration(t.sandboxSeconds), "wall-clock", m) },
        { m -> UsageStatTile("Tasks", "${t.tasksCompleted} done", "${t.tasksVerified} human-verified", m) },
    )
    LCard {
        tiles.chunked(2).forEachIndexed { i, row ->
            if (i > 0) LDivider(Modifier.padding(vertical = LSpace.xs))
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
                row.forEach { it(Modifier.weight(1f)) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        LDivider(Modifier.padding(vertical = LSpace.s))
        UsageDailyBars(d)
    }
}

/** "Runs per UTC day" column chart: honest zero ticks, peak scale, first/last day. */
@Composable
internal fun UsageDailyBars(d: MetricsSummaryResponse) {
    val p = Orcha.palette
    val days = d.daily
    val max = days.maxOfOrNull { it.runs } ?: 0
    val total = days.sumOf { it.runs }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Runs per UTC day", style = ltype(LType.Meta), color = p.text2, modifier = Modifier.weight(1f))
            Text("peak $max", style = ltype(LType.Micro), color = p.muted)
        }
        val bar = p.accent
        val tick = p.border2
        Canvas(
            Modifier.fillMaxWidth().height(64.dp).semantics {
                contentDescription = "Runs per day over the last ${d.days} days: $total in total, peak $max"
            },
        ) {
            if (days.isEmpty()) return@Canvas
            val gap = (if (days.size > 14) 2.dp else 4.dp).toPx()
            val w = ((size.width - gap * (days.size - 1)) / days.size).coerceAtLeast(1f)
            days.forEachIndexed { i, x ->
                val left = i * (w + gap)
                if (x.runs == 0 || max == 0) {
                    drawRect(tick, Offset(left, size.height - 1.dp.toPx()), Size(w, 1.dp.toPx()))
                } else {
                    val h = (size.height * x.runs / max).coerceAtLeast(2.dp.toPx())
                    drawRoundRect(bar, Offset(left, size.height - h), Size(w, h), CornerRadius(2.dp.toPx()))
                }
            }
        }
        if (days.isNotEmpty()) {
            Row(Modifier.clearAndSetSemantics {}) {
                Text(UsageFormat.day(days.first().date), style = ltype(LType.Micro), color = p.muted, modifier = Modifier.weight(1f))
                Text(UsageFormat.day(days.last().date), style = ltype(LType.Micro), color = p.muted)
            }
        }
    }
}

// ── cost & activity by agent ──

internal fun OrchaPalette.healthColor(h: RunHealth): Color = when (h) {
    RunHealth.OnTrack -> ok
    RunHealth.AtRisk -> warn
    RunHealth.OffTrack -> danger
    RunHealth.NoData -> muted
}

@Composable
internal fun UsageHealthChip(a: MxAgentDto) {
    val h = UsageFormat.health(a)
    LTag(UsageFormat.healthLabel(h), tint = Orcha.palette.healthColor(h))
}

/** Compact two-line agent row: avatar · alias · model + health; figures + cost share bar. */
@Composable
internal fun UsageAgentRow(
    a: MxAgentDto,
    modelName: String?,
    costText: String,
    barFraction: Float?,
    onClick: () -> Unit,
) {
    val p = Orcha.palette
    val name = a.alias ?: "Agent"
    val health = UsageFormat.health(a)
    val tokens = if (a.runsWithTokens > 0 || a.tokensIn + a.tokensOut > 0)
        "${UsageFormat.tokens(a.tokensIn)} in · ${UsageFormat.tokens(a.tokensOut)} out" else "tokens not reported"
    val summary = "$name, ${modelName ?: UsageFormat.MODEL_UNKNOWN}, ${UsageFormat.healthLabel(health)}. " +
        "${UsageFormat.healthDetail(a)}. Compute ${UsageFormat.duration(a.sandboxSeconds)}. $tokens. Cost $costText. Opens spend detail."
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(6.dp))
            .clickable(role = Role.Button, onClickLabel = "View spend detail", onClick = onClick)
            .clearAndSetSemantics { contentDescription = summary }
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            LAvatar(name, isAI = true, size = 24.dp)
            Column(Modifier.weight(1f)) {
                Text(name, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    ModelProviderMark(a.model, size = 12.dp, decorative = true)
                    Text(
                        modelName ?: UsageFormat.MODEL_UNKNOWN, style = ltype(LType.Micro),
                        color = if (modelName == null) p.faint else p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            UsageHealthChip(a)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Text(
                "${a.okRuns} / ${a.runs} runs · ${UsageFormat.duration(a.sandboxSeconds)} · $tokens",
                style = ltype(LType.Micro), color = p.text2, modifier = Modifier.weight(1f),
            )
            Text(costText, style = ltype(LType.Meta), color = if (costText == UsageFormat.NOT_REPORTED) p.muted else p.text)
        }
        UsageShareBar(barFraction, p.accent)
    }
}

/** Thin magnitude bar; nothing drawn when there is nothing honest to show. */
@Composable
internal fun UsageShareBar(fraction: Float?, color: Color, modifier: Modifier = Modifier) {
    val track = Orcha.palette.surface3
    Box(modifier.fillMaxWidth().height(3.dp).clip(CircleShape).background(track)) {
        if (fraction != null && fraction > 0f) {
            Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(3.dp).clip(CircleShape).background(color))
        }
    }
}

// ── token usage ──

@Composable
internal fun TokenUsageSection(
    window: String,
    onWindow: (String) -> Unit,
    w: TokenWindowDto?,
    lastWake: LastWakeDto?,
) {
    val p = Orcha.palette
    LSection("Token usage") {
        LSegmented(UsageFormat.TOKEN_WINDOWS, window, onWindow)
        if (w == null || w.runs == 0 && w.totalTokens == 0L) {
            LCard {
                Text("No measured usage yet", style = ltype(LType.BodyEmph), color = p.text)
                Text(
                    "Figures appear once agents wake and record usage.",
                    style = ltype(LType.Meta), color = p.muted,
                )
            }
        } else {
            LCard { TokenHero(w) }
            LCard { TokenMix(w) }
        }
        if (lastWake != null && lastWake.runId != null) LastWakeCard(lastWake)
    }
}

@Composable
private fun TokenHero(w: TokenWindowDto) {
    val p = Orcha.palette
    val frac = UsageFormat.quotaFraction(w)
    val cost = UsageFormat.spendCostText(w.runs, w.totalCostUsd, w.runsWithCost ?: if (w.totalCostUsd > 0) w.runs else 0)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.l)) {
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Total tokens", style = ltype(LType.Micro), color = p.muted)
            Text(UsageFormat.tokens(w.totalTokens), style = ltype(LType.Display), color = p.text)
            Text("$cost · ${plural(w.runs, "run")}", style = ltype(LType.Meta), color = p.text2)
        }
        QuotaRing(frac, w.quotaTokens)
    }
}

@Composable
private fun QuotaRing(fraction: Double?, quota: Long?) {
    val p = Orcha.palette
    val color = when {
        fraction == null -> p.border2
        fraction >= 1.0 -> p.danger
        fraction >= 0.8 -> p.warn
        else -> p.accent
    }
    val track = p.surface3
    val label = if (fraction == null) "Quota not configured"
    else "${UsageFormat.percent(fraction)} of the ${UsageFormat.tokens(quota ?: 0)} token quota"
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.width(96.dp).clearAndSetSemantics { contentDescription = label },
    ) {
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(64.dp)) {
                val sw = 6.dp.toPx()
                val inset = sw / 2
                val arcSize = Size(size.width - sw, size.height - sw)
                drawArc(track, -90f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(sw))
                if (fraction != null && fraction > 0) {
                    drawArc(color, -90f, (360f * fraction.coerceAtMost(1.0)).toFloat(), false, Offset(inset, inset), arcSize, style = Stroke(sw, cap = StrokeCap.Round))
                }
            }
            Text(if (fraction == null) "—" else UsageFormat.percent(fraction), style = ltype(LType.Meta), color = p.text)
        }
        Text(
            if (fraction == null) "Quota not configured" else "of quota",
            style = ltype(LType.Micro), color = p.muted, maxLines = 2,
        )
    }
}

@Composable
internal fun mixColors(): List<Color> {
    val p = Orcha.palette
    return listOf(p.accent, p.violet, p.accent.copy(alpha = 0.35f), p.info)
}

@Composable
internal fun TokenMix(w: TokenWindowDto) {
    val p = Orcha.palette
    val parts = UsageFormat.tokenMix(w)
    val colors = mixColors()
    Text("Token mix", style = ltype(LType.Meta), color = p.text2)
    Spacer(Modifier.height(LSpace.s))
    if (parts.any { it.tokens > 0 }) {
        Row(
            Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(p.surface3).clearAndSetSemantics {},
            horizontalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            parts.forEachIndexed { i, part ->
                if (part.fraction > 0.0) {
                    Box(Modifier.weight(part.fraction.toFloat().coerceAtLeast(0.004f)).height(8.dp).background(colors[i]))
                }
            }
        }
        Spacer(Modifier.height(LSpace.s))
    }
    parts.forEachIndexed { i, part ->
        Row(
            Modifier.fillMaxWidth().padding(vertical = 3.dp).semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(colors[i]))
            Text(part.label, style = ltype(LType.Body), color = p.text2, modifier = Modifier.weight(1f))
            Text(UsageFormat.tokens(part.tokens), style = ltype(LType.BodyEmph), color = p.text)
            Text(UsageFormat.percent(part.fraction), style = ltype(LType.Meta), color = p.muted, modifier = Modifier.width(48.dp))
        }
    }
    Spacer(Modifier.height(LSpace.xs))
    Text(UsageFormat.CACHE_NOTE, style = ltype(LType.Micro), color = p.muted)
}

@Composable
private fun LastWakeCard(w: LastWakeDto) {
    val p = Orcha.palette
    val who = w.agentAlias ?: "An agent"
    val whenText = w.endedAt?.let { relativeTimeShort(it) }
    LCard {
        Row(
            Modifier.semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            LAvatar(who, isAI = true, size = 24.dp)
            Column(Modifier.weight(1f)) {
                Text("Latest wake", style = ltype(LType.Micro), color = p.muted)
                Text(who + (whenText?.let { " · $it" } ?: ""), style = ltype(LType.BodyEmph), color = p.text)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(UsageFormat.tokens(w.totalTokens) + " tokens", style = ltype(LType.Meta), color = p.text)
                Text(if (w.totalCostUsd > 0) UsageFormat.usd(w.totalCostUsd) else UsageFormat.NOT_REPORTED, style = ltype(LType.Micro), color = p.muted)
            }
        }
    }
}

/** "3h ago" from an ISO timestamp; null when it can't be parsed. */
internal fun relativeTimeShort(iso: String): String? = runCatching {
    val then = java.time.OffsetDateTime.parse(iso).toInstant()
    val s = java.time.Duration.between(then, java.time.Instant.now()).seconds.coerceAtLeast(0)
    when {
        s < 60 -> "just now"
        s < 3_600 -> "${s / 60}m ago"
        s < 86_400 -> "${s / 3_600}h ago"
        else -> "${s / 86_400}d ago"
    }
}.getOrNull()

// ── budgets (web BudgetBars) ──

@Composable
internal fun UsageBudgetBars(b: ProjectBudgetsResponse, onlyAgentId: String? = null) {
    val rows = buildList {
        // Like the web: only meters with a limit set ("none" = no budget) are drawn.
        if (b.project.state != "none") add("Project" to b.project)
        b.agents.filter { (onlyAgentId == null || it.agentId == onlyAgentId) && it.state != "none" }
            .forEach { add((it.alias ?: "Agent") to it) }
    }
    if (rows.isEmpty()) return
    LSection("Budgets" + if (b.period.isNotEmpty()) " · ${b.period}" else "") {
        LCard {
            rows.forEachIndexed { i, (name, s) ->
                if (i > 0) LDivider(Modifier.padding(vertical = LSpace.s))
                BudgetBarRow(name, s)
            }
        }
    }
}

@Composable
private fun ColumnScope.BudgetBarRow(name: String, s: BudgetStatusDto) {
    val p = Orcha.palette
    val tone = when {
        s.paused || s.state == "exceeded" -> p.danger
        s.state == "warning" -> p.warn
        else -> p.accent
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
        if (s.paused) LTag("Paused", tint = p.danger) else if (s.override.active) LTag("Override", tint = p.warn)
    }
    val usdText = if (s.limits.usd == null) "No dollar limit"
    else UsageFormat.usd(s.usage.spendUsd) + " of " + UsageFormat.usd(s.limits.usd) + (s.usdRatio?.let { " · " + UsageFormat.percent(it) } ?: "")
    BudgetMeter(usdText, if (s.limits.usd != null) s.usdRatio else null, tone)
    if (s.limits.tokens != null) {
        val tokText = UsageFormat.tokens(s.usage.tokens) + " of " + UsageFormat.tokens(s.limits.tokens) + " tokens · incl. cache"
        BudgetMeter(tokText, s.tokenRatio, tone)
    }
}

@Composable
private fun BudgetMeter(text: String, ratio: Double?, tone: Color) {
    val p = Orcha.palette
    Column(Modifier.padding(top = 4.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if (ratio != null) UsageShareBar(ratio.toFloat().coerceIn(0.01f, 1f), tone)
        Text(text, style = ltype(LType.Micro), color = if (ratio == null) p.muted else p.text2)
    }
}

// ── loading skeleton ──

@Composable
internal fun UsageSkeleton() {
    val p = Orcha.palette
    Column(
        Modifier.semantics { contentDescription = "Loading metrics" },
        verticalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        listOf(120.dp, 72.dp, 52.dp, 52.dp, 52.dp).forEach { h ->
            Box(Modifier.fillMaxWidth().height(h).clip(RoundedCornerShape(8.dp)).background(p.surface2))
        }
    }
}
