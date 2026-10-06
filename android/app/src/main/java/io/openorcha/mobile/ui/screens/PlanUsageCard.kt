package io.openorcha.mobile.ui.screens

/* Plan usage (desktop "Usage" panel parity) — compact card at the top of Projects.
   Reads GET /api/plan-usage from every paired portal (each base URL once), merges the
   newest snapshot per provider, polls every 2 minutes while the screen is started.
   Tapping opens [PlanUsageSheet]. Also holds the shared loader [rememberPlanUsage]. */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.openorcha.mobile.data.PlanUsageApi
import io.openorcha.mobile.data.PlanUsageDisplayBody
import io.openorcha.mobile.domain.PlanUsageDisplay
import io.openorcha.mobile.domain.PlanUsageProviders
import io.openorcha.mobile.domain.PlanUsageEntry
import io.openorcha.mobile.domain.PlanUsageTone
import io.openorcha.mobile.domain.PlanUsageUx
import io.openorcha.mobile.domain.PlanUsageView
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ProviderMark
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

/** Loader state: [view] is null until the first read lands. */
@Stable
class PlanUsageState {
    var view by mutableStateOf<PlanUsageView?>(null)
    var loading by mutableStateOf(false)
    /** Every portal failed on the last read (kept separate from "no desktop"). */
    var unreachable by mutableStateOf(false)
    var now by mutableStateOf(Instant.now())
    /** A user-started refresh (pull / refresh button) is in flight — polls don't spin. */
    var refreshing by mutableStateOf(false)
    internal var reloadTick by mutableIntStateOf(0)
    fun refresh() { refreshing = true; reloadTick++ }
}

/**
 * The portal-wide "Show plan usage" setting, shared by every screen (Home card, Settings
 * sheet) so a change repaints everywhere at once. Reads merge per the sync rule (newest
 * `updated_at` wins, default off); writes are optimistic, then PUT to every paired portal.
 */
object PlanUsageDisplayStore {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var display by mutableStateOf(PlanUsageDisplay.DEFAULT)
        private set

    /** Bumped on every local edit: a read that started before an edit must not clobber it. */
    private var generation = 0
    private var writesInFlight = 0

    suspend fun refresh(baseUrls: Collection<String>) {
        val gen = generation
        val read = runCatching { PlanUsageApi.allDisplays(baseUrls) }.getOrNull() ?: return
        if (gen != generation || writesInFlight > 0) return
        display = PlanUsageUx.mergeDisplayDtos(read)
    }

    fun update(show: Boolean, providers: PlanUsageProviders, baseUrls: Collection<String>) {
        val next = display.copy(show = show, providers = providers)
        if (next == display) return
        display = next
        generation++
        writesInFlight++
        val gen = generation
        val body = PlanUsageDisplayBody(show, providers.wire)
        scope.launch {
            val stored = try {
                PlanUsageApi.putDisplayEverywhere(baseUrls.toList(), body)
            } finally {
                writesInFlight--
            }
            // Adopt the portals' timestamp, unless the user changed it again meanwhile.
            if (gen == generation && stored.isNotEmpty()) {
                val merged = PlanUsageUx.mergeDisplayDtos(stored)
                if (merged.show == show && merged.providers == providers) display = merged
            }
        }
    }
}

/** Reads + merges plan usage (and the display setting) for [baseUrls]; polls every 2 min while the lifecycle is STARTED. */
@Composable
fun rememberPlanUsage(baseUrls: List<String>): PlanUsageState {
    val state = remember { PlanUsageState() }
    val urls = remember(baseUrls) { baseUrls.distinct() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(urls, state.reloadTick) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Keep "Updated 2m ago" / "resets in" fresh between reads.
            launch { while (true) { state.now = Instant.now(); delay(30_000) } }
            while (true) {
                state.loading = true
                launch { PlanUsageDisplayStore.refresh(urls) }
                val snaps = runCatching { PlanUsageApi.allSnapshots(urls) }.getOrNull()
                state.unreachable = snaps == null && urls.isNotEmpty()
                if (snaps != null) state.view = PlanUsageUx.merge(snaps)
                else if (state.view == null) state.view = PlanUsageView(emptyList(), null, null)
                state.now = Instant.now()
                state.loading = false
                state.refreshing = false
                delay(PlanUsageUx.POLL_MS)
            }
        }
    }
    return state
}

@Composable
internal fun planUsageToneColor(tone: PlanUsageTone): Color {
    val p = Orcha.palette
    return when (tone) {
        PlanUsageTone.Neutral -> p.text2
        PlanUsageTone.Warn -> p.warn
        PlanUsageTone.Danger -> p.danger
    }
}

/** Thin rounded usage bar coloured by threshold. Decorative — callers own semantics. */
@Composable
internal fun PlanUsageBar(pct: Double, modifier: Modifier = Modifier) {
    val track = Orcha.palette.surface3
    val fill = planUsageToneColor(PlanUsageUx.tone(pct))
    val frac = (PlanUsageUx.clampPct(pct) / 100.0).toFloat()
    Canvas(modifier.height(4.dp)) {
        val rad = CornerRadius(size.height / 2)
        drawRoundRect(track, Offset.Zero, size, rad)
        if (frac > 0f) drawRoundRect(fill, Offset.Zero, Size((size.width * frac).coerceAtLeast(size.height), size.height), rad)
    }
}

/** Compact card: "Usage  34%" then one row per chosen provider (mark · name · plan · bar · % · resets in).
 *  Hidden entirely while the portal-wide "Show plan usage" setting is off (the default). */
@Composable
fun PlanUsageCard(usage: PlanUsageState, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val display = PlanUsageDisplayStore.display
    if (!display.show) return
    val view = PlanUsageUx.filter(usage.view ?: return, display.providers)
    val now = usage.now
    val summary = PlanUsageUx.cardSummary(view, now)
    LCard(
        modifier
            .clickable(role = Role.Button, onClickLabel = "Open plan usage", onClick = onOpen)
            .clearAndSetSemantics {
                contentDescription = summary
                role = Role.Button
                onClick(label = "Open plan usage") { onOpen(); true }
            },
    ) {
        Column(Modifier.heightIn(min = 48.dp), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Usage", style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
                PlanUsageUx.overallPct(view)?.let {
                    Text(PlanUsageUx.pctText(it), style = ltype(LType.BodyEmph), color = planUsageToneColor(PlanUsageUx.tone(it)))
                }
                Icon(OrchaIcons.ChevronRight, contentDescription = null, tint = p.muted, modifier = Modifier.padding(start = LSpace.xs))
            }
            if (view.isEmpty) {
                Text(
                    if (usage.unreachable) "Couldn't reach your Embodent. Pull to refresh." else PlanUsageUx.EMPTY_MESSAGE,
                    style = ltype(LType.Meta), color = p.muted,
                )
            } else {
                view.entries.forEach { CompactProviderRow(it, now) }
                if (PlanUsageUx.isStale(view, now)) {
                    Text(
                        listOfNotNull(PlanUsageUx.updatedLine(view, now), PlanUsageUx.STALE_NOTE).joinToString(" · "),
                        style = ltype(LType.Meta), color = p.muted,
                    )
                }
            }
        }
    }
}

@Composable
private fun CompactProviderRow(e: PlanUsageEntry, now: Instant) {
    val p = Orcha.palette
    val w = PlanUsageUx.mostConstrained(e.usage)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            PlanUsageUx.markFor(e.usage.provider)?.let { ProviderMark(it, size = 14.dp, decorative = true) }
            Text(PlanUsageUx.providerName(e.usage.provider), style = ltype(LType.Body).copy(fontWeight = FontWeight.Medium), color = p.text)
            e.usage.plan?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            Row(Modifier.weight(1f)) {}
            if (w != null) Text(PlanUsageUx.pctText(w.usedPct), style = ltype(LType.Meta), color = p.text2)
        }
        if (w != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                PlanUsageBar(w.usedPct, Modifier.weight(1f))
                PlanUsageUx.compactReset(w, now)?.let {
                    Text(it, style = ltype(LType.Meta), color = p.muted, maxLines = 1)
                }
            }
        }
    }
}
