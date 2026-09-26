package io.openorcha.mobile.ui.screens

/** Owns live and completed worker-run detail presentation. */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.openorcha.mobile.ui.icons.OrchaIcons
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.FeedRow
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
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
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    Column {
                        Text(run?.runId?.take(6) ?: "run", style = MonoStyle.copy(fontWeight = FontWeight.W700))
                        Text(run?.taskTitle ?: run?.wakeEvent ?: "", style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = { IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            run?.let {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusPill(it.status, StatusDomain.Run)
                    it.wakeKind?.let { wk -> MetaTag(wk) }
                    it.agentAlias?.let { a -> MetaTag(a) }
                    Spacer(Modifier.weight(1f))
                    if (it.status == "running") {
                        DangerTonalButton("Stop run", { confirmStop = true }, small = true, enabled = !state.actionInFlight)
                    }
                }
                if (it.status != "running") {
                    val kind = when (it.status) {
                        "exited", "finished" -> BannerKind.Info
                        "killed", "failed", "error" -> BannerKind.Danger
                        else -> BannerKind.Info
                    }
                    Banner(kind, "Run ${MobileUx.statusCopy(it.status)}${MobileUx.agoLabel(it.endedAt)?.let { t -> " · $t" } ?: ""}")
                }
            }
            state.runStreamNote?.let { Banner(BannerKind.Info, it) }
            OrchaCard(Modifier.weight(1f)) {
                if (state.runFeed.isEmpty()) {
                    Text(
                        when {
                            state.loading -> "Loading stream…"
                            run?.status == "running" -> "Streaming — waiting for the first log line…"
                            else -> "No log lines yet."
                        },
                        color = p.muted,
                    )
                } else {
                    androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth()) {
                        LazyColumn(state = listState) {
                            items(state.runFeed.size) { i ->
                                val row = state.runFeed[i]
                                FeedRow(row.type, row.label, row.text, row.detail)
                            }
                        }
                        if (!atBottom) {
                            androidx.compose.material3.SuggestionChip(
                                onClick = { scope.launch { listState.animateScrollToItem(state.runFeed.size - 1) } },
                                label = { Text("Auto-scroll paused · Jump to latest", style = MaterialTheme.typography.labelMedium) },
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
            title = { Text("Stop this run?") },
            text = { Text("${run?.agentAlias ?: "The"} worker is interrupted mid-turn. The log so far is kept and the run is marked stopped.") },
            confirmButton = {
                TextButton(onClick = { confirmStop = false; onStop() }) { Text("Stop run", color = p.danger, fontWeight = FontWeight.W700) }
            },
            dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }
}
