package io.openorcha.mobile.ui.screens

/** Owns the paged task conversation and its message composer. */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TaskMessageDto
import io.openorcha.mobile.domain.ActivityCopy
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 05 — Task detail + thread. Flow 06 — worker runs + streaming log.
   ============================================================================= */

@OptIn(ExperimentalLayoutApi::class)
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
        containerColor = p.bg,
        topBar = {
            LTopBar(title = "Thread", subtitle = task?.title, onBack = onBack) {
                IconButton(onClick = onRefresh) { Icon(OrchaIcons.Refresh, "Refresh", tint = p.text2) }
            }
        },
        bottomBar = {
            TaskCommentComposer(
                assignee = task?.assignees?.firstOrNull(),
                busy = state.actionInFlight,
                onSend = { text -> pendingSend = text; onSendMessage(text) },
                onOpenThread = {},
                placeholder = "Message ${task?.assignees?.firstOrNull() ?: "the thread"}…",
                draftState = draft to { draft = it },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            state = listState,
            contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
            verticalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            // issue 4: keyset "Load earlier" — older pages prepend above (web reveal affordance)
            if (state.threadHasMore) {
                item(key = "load-earlier") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        LButton(
                            if (state.threadLoadingEarlier) "Loading…" else "Load earlier messages",
                            onLoadEarlier,
                            kind = LButtonKind.Ghost,
                            size = LSize.Small,
                            enabled = !state.threadLoadingEarlier,
                        )
                    }
                }
            }
            if (state.taskMessages.isEmpty()) {
                item {
                    LEmptyState(
                        icon = OrchaIcons.Forum,
                        title = "No messages yet",
                        message = "Say hi to ${task?.assignees?.firstOrNull() ?: "the assignee"}.",
                    )
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
                            style = ltype(LType.Micro),
                            color = p.danger,
                            modifier = Modifier
                                .clickable { onSendMessage(text) }
                                .heightIn(min = 48.dp)
                                .padding(vertical = 16.dp),
                        )
                    }
                }
            }
            if (unsent == null) state.error?.let { item { Banner(BannerKind.Danger, it) } }
        }
    }
}

@Composable
private fun ThreadBubble(msg: TaskMessageDto, humanId: String?, tasks: List<TaskDto>, onOpenTask: (String) -> Unit) {
    val mine = msg.authorId != null && msg.authorId == humanId
    val system = msg.authorId == null && !msg.isHuman
    when {
        system -> Bubble(BubbleKind.System, ActivityCopy.humanize(msg.body), tasks = tasks, onOpenTask = onOpenTask)
        mine -> Bubble(BubbleKind.Mine, ActivityCopy.humanize(msg.body), time = MobileUx.agoLabel(msg.createdAt), tasks = tasks, onOpenTask = onOpenTask)
        else -> Bubble(
            BubbleKind.Theirs, ActivityCopy.humanize(msg.body),
            author = msg.authorAlias ?: if (msg.isHuman) "human" else "agent",
            time = MobileUx.agoLabel(msg.createdAt),
            tasks = tasks, onOpenTask = onOpenTask,
        )
    }
}

