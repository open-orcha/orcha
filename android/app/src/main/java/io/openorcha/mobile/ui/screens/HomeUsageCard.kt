package io.openorcha.mobile.ui.screens

/* Home tab "This week" usage card (web Home usage summary): est. cost + runs on the
   left, a 7-bar runs-per-day sparkline + chevron on the right. One tap target that
   opens Metrics & usage. Uses the same read-only GET /metrics?days=7 as that screen. */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.MetricsSummaryResponse
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.UsageApi
import io.openorcha.mobile.domain.HomeUsage
import io.openorcha.mobile.domain.UsageFormat
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

private sealed interface HomeUsageLoad {
    data object Loading : HomeUsageLoad
    data object Failed : HomeUsageLoad
    data class Loaded(val data: MetricsSummaryResponse) : HomeUsageLoad
}

/** [refreshing] is the workspace's pull/explicit refresh flag: the card reloads when it settles. */
@Composable
internal fun HomeUsageCard(container: StoredContainer, refreshing: Boolean, onOpen: () -> Unit) {
    val p = Orcha.palette
    var load by remember(container.id) { mutableStateOf<HomeUsageLoad>(HomeUsageLoad.Loading) }
    LaunchedEffect(container.id, container.baseUrl, refreshing) {
        if (refreshing) return@LaunchedEffect
        runCatching { UsageApi.summary(container.baseUrl, container.id, HomeUsage.DAYS) }
            .onSuccess { load = HomeUsageLoad.Loaded(it) }
            // Keep the last good figures on a transient failure.
            .onFailure { if (load !is HomeUsageLoad.Loaded) load = HomeUsageLoad.Failed }
    }
    val data = (load as? HomeUsageLoad.Loaded)?.data?.takeIf { it.totals.runs > 0 }
    val label = HomeUsage.accessibilityLabel(data?.totals)
    val shape = RoundedCornerShape(p.radiusCard.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(shape)
            .background(p.surface)
            .border(1.dp, p.border, shape)
            .clickable(role = Role.Button, onClick = onOpen)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                onClick(label = "Open Metrics and usage") { onOpen(); true }
            }
            .padding(horizontal = LSpace.m, vertical = LSpace.s + 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("This week", style = ltype(LType.Micro), color = p.muted)
            when {
                load is HomeUsageLoad.Loading -> Box(
                    Modifier.padding(vertical = 6.dp).width(120.dp).height(14.dp)
                        .clip(RoundedCornerShape(4.dp)).background(p.surface3),
                )
                data == null -> Text(HomeUsage.NO_RUNS, style = ltype(LType.Body), color = p.text2)
                else -> {
                    val unreported = UsageFormat.costUnreported(data.totals)
                    Text(
                        HomeUsage.costHeadline(data.totals),
                        style = ltype(if (unreported) LType.Headline else LType.Title),
                        color = if (unreported) p.muted else p.text,
                    )
                    Text(HomeUsage.runsCaption(data.totals), style = ltype(LType.Meta), color = p.muted)
                }
            }
        }
        if (data != null) {
            val bars = HomeUsage.sparkline(data.daily)
            val peak = p.accent
            val muted = p.border2
            Canvas(Modifier.width(64.dp).height(28.dp)) {
                val gap = 3.dp.toPx()
                val w = ((size.width - gap * (bars.size - 1)) / bars.size).coerceAtLeast(1f)
                bars.forEachIndexed { i, b ->
                    val left = i * (w + gap)
                    if (b.fraction <= 0f) {
                        val t = 2.dp.toPx()
                        drawRect(muted, Offset(left, size.height - t), Size(w, t))
                    } else {
                        val h = (size.height * b.fraction).coerceAtLeast(2.dp.toPx())
                        drawRoundRect(if (b.peak) peak else muted, Offset(left, size.height - h), Size(w, h), CornerRadius(1.5.dp.toPx()))
                    }
                }
            }
        }
        Icon(OrchaIcons.ChevronRight, null, tint = p.muted, modifier = Modifier.size(16.dp))
    }
}
