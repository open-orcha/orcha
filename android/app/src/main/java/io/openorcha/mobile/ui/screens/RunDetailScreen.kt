package io.openorcha.mobile.ui.screens

/** Owns live and completed worker-run detail presentation. */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.FeedRow
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

/* =============================================================================
   Flow 06 — worker run detail: classified feed (no raw JSON), pin-to-bottom, stop-run.
   ============================================================================= */

@Composable
fun RunDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onStop: () -> Unit,
) {
    val p = Orcha.palette
    val run = state.selectedRun
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var confirmStop by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val atBottom by remember {
        androidx.compose.runtime.derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount == 0 || last >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(state.runFeed.size) {
        // pin-to-bottom only while the user hasn't scrolled up (flow 06 §auto-scroll)
        if (state.runFeed.isNotEmpty() && atBottom) listState.animateScrollToItem(state.runFeed.size - 1)
    }
    Scaffold(
        containerColor = p.bg,
        topBar = {
            LTopBar(
                title = run?.runId?.take(6) ?: "Run",
                subtitle = run?.taskTitle ?: run?.wakeEvent?.let(ActivityCopy::humanize),
                monoTitle = run != null,
                onBack = onBack,
            ) {
                IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh", tint = p.text2) }
            }
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = LSpace.l, vertical = LSpace.m),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            run?.let {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    LStatusGlyph(runGlyphStatus(it.status), size = 15.dp)
                    Text(
                        MobileUx.statusCopy(it.status).capitalizedFirst() +
                            (if (it.status != "running") MobileUx.agoLabel(it.endedAt)?.let { t -> " · $t" } ?: "" else ""),
                        style = ltype(LType.Meta),
                        color = if (it.status == "running") p.warn else p.text2,
                        maxLines = 1,
                    )
                    it.wakeKind?.let { wk -> LTag(wk) }
                    io.openorcha.mobile.ui.components.ModelProviderMark(it.runtime)
                    Spacer(Modifier.weight(1f))
                    it.agentAlias?.let { a -> LAvatar(a, isAI = true, size = 20.dp) }
                    if (it.status == "running") {
                        LButton("Stop run", { confirmStop = true }, kind = LButtonKind.Danger, size = LSize.Small, enabled = !state.actionInFlight)
                    }
                }
            }
            // Live changes while the agent works (polled; a finished run's changes read once)
            val changesBase = state.selectedContainer?.baseUrl
            val changesAgent = run?.agentId ?: state.selectedAgent?.id
            if (run != null && changesBase != null && changesAgent != null) {
                RunChangesBar(changesBase, changesAgent, run.runId, running = run.status == "running")
            }
            state.runStreamNote?.let { Text(it, style = ltype(LType.Meta), color = p.faint) }
            LCard(Modifier.weight(1f)) {
                if (state.runFeed.isEmpty()) {
                    Text(
                        when {
                            state.loading -> "Loading stream…"
                            run?.status == "running" -> "Streaming — waiting for the first log line…"
                            else -> "No log lines yet."
                        },
                        style = ltype(LType.Meta),
                        color = p.faint,
                    )
                } else {
                    Box(Modifier.fillMaxWidth()) {
                        LazyColumn(state = listState, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            items(state.runFeed.size) { i ->
                                val row = state.runFeed[i]
                                FeedRow(row.type, row.label, row.text, row.detail)
                            }
                        }
                        if (!atBottom) {
                            LButton(
                                "Jump to latest",
                                { scope.launch { listState.animateScrollToItem(state.runFeed.size - 1) } },
                                kind = LButtonKind.Secondary,
                                size = LSize.Small,
                                modifier = Modifier.align(Alignment.BottomCenter),
                            )
                        }
                    }
                }
            }
            state.error?.let { Banner(BannerKind.Danger, it, action = "Retry", onAction = onRefresh) }
        }
    }
    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text("Stop this run?", style = ltype(LType.Headline), color = p.text) },
            text = {
                Text(
                    "${run?.agentAlias ?: "The"} worker is interrupted mid-turn. The log so far is kept and the run is marked stopped.",
                    style = ltype(LType.Body), color = p.text2,
                )
            },
            confirmButton = { LButton("Stop run", { confirmStop = false; onStop() }, kind = LButtonKind.Danger) },
            dismissButton = { LButton("Cancel", { confirmStop = false }, kind = LButtonKind.Ghost) },
            containerColor = p.surface,
        )
    }
}
