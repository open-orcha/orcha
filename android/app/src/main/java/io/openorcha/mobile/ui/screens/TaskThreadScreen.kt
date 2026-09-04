package io.openorcha.mobile.ui.screens

/** Owns the paged task conversation and its message composer. */

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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TaskThreadScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSendMessage: (String) -> Unit,
    onLoadEarlier: () -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val p = Orcha.palette
    val task = state.selectedTask
    var draft by remember { mutableStateOf("") }
    var pendingSend by remember { mutableStateOf<String?>(null) }
    // a send that errored keeps its text as an unsent bubble with a retry chip
    val unsent = if (state.error != null) pendingSend else null
    val listState = rememberLazyListState()
    val imeVisible = WindowInsets.isImeVisible
    // issue 2: keep the newest messages in view when the keyboard opens or a message lands.
    // Keyed on the NEWEST message's identity (same expression as the item keys), not the list
    // size — a "Load earlier" prepend grows the size but leaves the newest message unchanged,
    // so the effect stays put and LazyColumn's key-based anchoring holds the viewport at the seam.
    val newestMessageKey = state.taskMessages.lastOrNull()?.let { it.messageId ?: "${it.createdAt}-${it.body.hashCode()}" }
    LaunchedEffect(newestMessageKey, imeVisible) {
        val last = listState.layoutInfo.totalItemsCount - 1
        if (last >= 0 && (imeVisible || state.taskMessages.isNotEmpty())) listState.animateScrollToItem(last)
    }
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    Column {
                        Text("Thread", style = MaterialTheme.typography.titleMedium)
                        Text(task?.title ?: "", style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = { IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh") } },
            )
        },
    ) { padding ->
        // issue 2: consumeWindowInsets stops imePadding re-adding the nav-bar inset the
        // Scaffold padding already applied (with adjustResize, that was the visible gap)
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            LazyColumn(
                modifier = Modifier.weight(1f),
                state = listState,
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // issue 4: keyset "Load earlier" — older pages prepend above (web reveal affordance)
                if (state.threadHasMore) {
                    item(key = "load-earlier") {
                        androidx.compose.material3.TextButton(
                            onClick = onLoadEarlier,
                            enabled = !state.threadLoadingEarlier,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                if (state.threadLoadingEarlier) "Loading…" else "Load earlier messages",
                                color = p.accent, fontWeight = FontWeight.W700,
                            )
                        }
                    }
                }
                if (state.taskMessages.isEmpty()) {
                    item {
                        OrchaCard {
                            Text(
                                "No messages yet — say hi to ${task?.assignees?.firstOrNull() ?: "the assignee"}.",
                                color = p.muted,
                            )
                        }
                    }
                }
                items(state.taskMessages, key = { it.messageId ?: "${it.createdAt}-${it.body.hashCode()}" }) { msg ->
                    ThreadBubble(msg, state.selectedContainer?.humanAgentId, state.snapshot?.tasks.orEmpty(), onOpenTask)
                }
                unsent?.let { text ->
                    item {
                        Column(horizontalAlignment = Alignment.End, modifier = Modifier.fillMaxWidth()) {
                            Bubble(BubbleKind.Mine, text)
                            Text(
                                "Not sent · Tap to retry",
                                style = MaterialTheme.typography.labelMedium,
                                color = p.danger,
                                modifier = Modifier
                                    .padding(top = 2.dp)
                                    .clickable { onSendMessage(text) },
                            )
                        }
                    }
                }
                if (unsent == null) state.error?.let { item { Banner(BannerKind.Danger, it) } }
            }
            // `.composer` — rounded field + round send button
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OrchaField(
                    draft, { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Message ${task?.assignees?.firstOrNull() ?: "the thread"}…",
                    maxLines = 4,
                )
                IconButton(
                    onClick = { pendingSend = draft.trim(); onSendMessage(draft.trim()); draft = "" },
                    enabled = draft.isNotBlank() && !state.actionInFlight,
                    colors = androidx.compose.material3.IconButtonDefaults.iconButtonColors(
                        containerColor = p.accent, contentColor = p.accentInk,
                        disabledContainerColor = p.accent.copy(alpha = 0.4f), disabledContentColor = p.accentInk,
                    ),
                ) { Icon(OrchaIcons.Send, "Send") }
            }
        }
    }
}

@Composable
private fun ThreadBubble(msg: TaskMessageDto, humanId: String?, tasks: List<TaskDto>, onOpenTask: (String) -> Unit) {
    val mine = msg.authorId != null && msg.authorId == humanId
    val system = msg.authorId == null && !msg.isHuman
    when {
        system -> Bubble(BubbleKind.System, msg.body, tasks = tasks, onOpenTask = onOpenTask)
        mine -> Bubble(BubbleKind.Mine, msg.body, time = MobileUx.agoLabel(msg.createdAt), tasks = tasks, onOpenTask = onOpenTask)
        else -> Bubble(
            BubbleKind.Theirs, msg.body,
            author = msg.authorAlias ?: if (msg.isHuman) "human" else "agent",
            time = MobileUx.agoLabel(msg.createdAt),
            tasks = tasks, onOpenTask = onOpenTask,
        )
    }
}

/* ---------- flow 06 R2 — run detail: mono log, pin-to-bottom, stop-run ---------- */
