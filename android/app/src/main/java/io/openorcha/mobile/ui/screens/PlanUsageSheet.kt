package io.openorcha.mobile.ui.screens

/* Plan usage detail (mirrors the desktop "Usage" panel): per provider a header with name,
   plan and headline ("5h resets in 3h 26m"), each window as label · bar · %, with
   "92% left · resets today 4:49 PM · in 3h 26m" beneath (device-local time), then
   "Today 601M tokens · Est. $237.61". Staleness line on top. Above it all, the portal-wide
   display setting: "Show plan usage" switch, "Providers" (Both · Claude · Codex) and caption.
   The sheet itself always lists every provider; the setting only drives the Home card. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import io.openorcha.mobile.domain.PlanUsageProviders
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.PlanUsageWindowDto
import io.openorcha.mobile.domain.PlanUsageEntry
import io.openorcha.mobile.domain.PlanUsageUx
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ProviderMark
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import java.time.Instant

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanUsageSheet(usage: PlanUsageState, baseUrls: List<String>, onDismiss: () -> Unit) {
    val p = Orcha.palette
    val view = usage.view
    val now = usage.now
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = Modifier.statusBarsPadding(),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        LazyColumn(
            contentPadding = PaddingValues(start = LSpace.l, end = LSpace.l, bottom = LSpace.xl),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            item(key = "head") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            Text("Usage · all agents", style = ltype(LType.Title), color = p.text, modifier = Modifier.semantics { heading() })
                            view?.let { PlanUsageUx.overallPct(it) }?.let {
                                Text(PlanUsageUx.pctText(it), style = ltype(LType.Title), color = planUsageToneColor(PlanUsageUx.tone(it)))
                            }
                        }
                        view?.let { PlanUsageUx.updatedLine(it, now) }?.let { line ->
                            val stale = PlanUsageUx.isStale(view, now)
                            Text(
                                if (stale) "$line · ${PlanUsageUx.STALE_NOTE}" else line,
                                style = ltype(LType.Meta), color = if (stale) p.warn else p.muted,
                            )
                        }
                    }
                    IconButton(onClick = usage::refresh, enabled = !usage.loading) {
                        Icon(OrchaIcons.Refresh, "Refresh plan usage", tint = p.text2)
                    }
                }
            }
            item(key = "display") { DisplaySettingCard(baseUrls) }
            when {
                view == null -> item(key = "loading") {
                    Text("Loading plan usage…", style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(vertical = LSpace.l))
                }
                view.isEmpty -> item(key = "empty") {
                    if (usage.unreachable) {
                        LEmptyState(OrchaIcons.WarningAmber, "Plan usage is unavailable", "Couldn't reach your Embodent. Check your connection and try again.",
                            actionTitle = "Retry", onAction = usage::refresh)
                    } else {
                        LEmptyState(OrchaIcons.Schedule, "No plan usage yet", PlanUsageUx.EMPTY_MESSAGE)
                    }
                }
                else -> view.entries.forEach { e -> item(key = "p-${e.usage.provider}") { ProviderPanel(e, now) } }
            }
        }
    }
}

@Composable
private fun ProviderPanel(e: PlanUsageEntry, now: Instant) {
    val p = Orcha.palette
    val name = PlanUsageUx.providerName(e.usage.provider)
    LCard {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.m)) {
            Column(
                Modifier.semantics(mergeDescendants = true) { heading() },
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PlanUsageUx.markFor(e.usage.provider)?.let { ProviderMark(it, size = 16.dp, decorative = true) }
                    Text(name, style = ltype(LType.BodyEmph), color = p.text)
                    e.usage.plan?.takeIf { it.isNotBlank() }?.let { Text(it, style = ltype(LType.Body), color = p.muted) }
                }
                e.usage.headline?.takeIf { it.isNotBlank() }?.let { Text(it, style = ltype(LType.Meta), color = p.text2) }
            }
            if (e.usage.windows.isEmpty()) {
                Text("No limits reported", style = ltype(LType.Meta), color = p.muted)
            }
            e.usage.windows.forEachIndexed { i, w ->
                if (i > 0) LDivider()
                WindowRow(w, now)
            }
            PlanUsageUx.todayLine(e.usage.today)?.let { line ->
                LDivider()
                Text(line, style = ltype(LType.Meta).copy(fontWeight = FontWeight.Medium), color = p.text2)
            }
        }
    }
}

@Composable
private fun WindowRow(w: PlanUsageWindowDto, now: Instant) {
    val p = Orcha.palette
    val detail = PlanUsageUx.windowDetail(w, now)
    Column(
        Modifier.semantics(mergeDescendants = true) {
            contentDescription = "${w.label} window, ${PlanUsageUx.pctText(w.usedPct)} used. $detail"
        },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Text(
                w.label, style = ltype(LType.Body), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(min = 32.dp, max = 120.dp),
            )
            PlanUsageBar(w.usedPct, Modifier.weight(1f))
            Text(PlanUsageUx.pctText(w.usedPct), style = ltype(LType.Body), color = planUsageToneColor(PlanUsageUx.tone(w.usedPct)))
        }
        Text(detail, style = ltype(LType.Meta), color = p.muted)
    }
}

/** "Show plan usage" switch, "Providers" segmented control (enabled only when on), caption. */
@Composable
private fun DisplaySettingCard(baseUrls: List<String>) {
    val p = Orcha.palette
    val display = PlanUsageDisplayStore.display
    LCard {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .toggleable(
                        value = display.show,
                        role = Role.Switch,
                        onValueChange = { PlanUsageDisplayStore.update(it, display.providers, baseUrls) },
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(PlanUsageUx.DISPLAY_TITLE, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
                Switch(
                    checked = display.show,
                    onCheckedChange = null,
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = p.lPrimaryFill, checkedThumbColor = p.lPrimaryText,
                        uncheckedTrackColor = p.surface2, uncheckedBorderColor = p.border2, uncheckedThumbColor = p.faint,
                    ),
                )
            }
            LDivider()
            Row(
                Modifier
                    .fillMaxWidth()
                    .alpha(if (display.show) 1f else 0.4f)
                    .semantics { if (!display.show) disabled() },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
            ) {
                Text(PlanUsageUx.DISPLAY_PROVIDERS_TITLE, style = ltype(LType.Body), color = p.text, modifier = Modifier.weight(1f))
                LSegmented(
                    options = PlanUsageProviders.entries.map { it to it.title },
                    selection = display.providers,
                    onSelect = { if (display.show) PlanUsageDisplayStore.update(true, it, baseUrls) },
                )
            }
            Text(PlanUsageUx.DISPLAY_CAPTION, style = ltype(LType.Meta), color = p.muted)
        }
    }
}
