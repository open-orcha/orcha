package io.openorcha.mobile.ui.screens

/** Owns agent conversation history, presence, composer, and end confirmation. */

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.pulseAlpha
import io.openorcha.mobile.ui.components.pulsing
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, runs) + pickers.
   Flow 10 — Converse (honest presence, bubbles, composer, end confirm).
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ConversationScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSend: (String) -> Unit,
    onEnd: () -> Unit,
    onOpenRun: (RunDto) -> Unit,
    onOpenTask: (String) -> Unit,
    onRetry: () -> String? = { null },
) {
    val p = Orcha.palette
    val agent = state.selectedAgent
    var draft by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmEnd by remember { mutableStateOf(false) }
    val sendFlow = state.sendFlow
    val listState = rememberLazyListState()
    // issue 4: the web's client-side reveal (conversation.js REVEAL) — render the newest
    // 10 turns, "Load earlier" reveals +20 (the fetch already holds up to 80).
    var reveal by remember(agent?.id) { mutableStateOf(CONV_REVEAL_INITIAL) }
    val visibleTurns = if (state.turns.size > reveal) state.turns.takeLast(reveal) else state.turns
    val imeVisible = WindowInsets.isImeVisible
    val working = agent?.status == "working"
    // iOS parity: "Worked for …" under each agent reply (time since the human turn it answers)
    val workedFor = remember(state.turns, state.selectedContainer?.humanAgentId) {
        io.openorcha.mobile.domain.AgentInsights.workedFor(state.turns, state.selectedContainer?.humanAgentId)
    }
    // Live reply over the run SSE while a reply is in flight (turns polling stays the fallback)
    val lastIsHuman = state.turns.lastOrNull()?.let { it.role == "human" || it.authorAgentId == state.selectedContainer?.humanAgentId } == true
    val liveReply = rememberChatLiveReply(
        baseUrl = state.selectedContainer?.baseUrl,
        agentId = agent?.id,
        conversationId = state.conversation?.id,
        active = sendFlow.showsAwaitingReply || (lastIsHuman && working),
        onRunEnded = onRefresh,
    )
    // issue 2: keep the newest turns in view when the keyboard opens, a turn lands, or the
    // pending bubble appears/changes (chat send-UX: a new send scrolls the composer into view).
    LaunchedEffect(state.turns.size, imeVisible, sendFlow.showsPendingBubble, liveReply.showing) {
        val last = listState.layoutInfo.totalItemsCount - 1
        if (last >= 0 && (imeVisible || state.turns.isNotEmpty())) listState.animateScrollToItem(last)
    }

    // Mic: the system speech recognizer (no RECORD_AUDIO permission needed) — the
    // transcript lands in the composer for review before sending.
    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (result.resultCode == Activity.RESULT_OK && !heard.isNullOrBlank()) {
            draft = if (draft.isBlank()) heard else "${draft.trimEnd()} $heard"
        }
    }
    val context = LocalContext.current
    val canDictate = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).resolveActivity(context.packageManager) != null
    }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg, titleContentColor = p.text),
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            LAvatar(agent?.alias ?: "?", isAI = true, size = 20.dp, status = agent?.status)
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(agent?.alias ?: "Conversation", style = ltype(LType.Headline), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    io.openorcha.mobile.ui.components.ModelProviderMark(agent?.model, size = 12.dp)
                                    Text(agentStatusLabel(agent?.status ?: "idle"), style = ltype(LType.Micro), color = p.muted, maxLines = 1)
                                }
                            }
                        }
                    },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back", tint = p.text2) } },
                    actions = {
                        IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More actions", tint = p.accent) }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("Refresh") }, onClick = { menuOpen = false; onRefresh() })
                            DropdownMenuItem(text = { Text("End conversation", color = p.danger) }, onClick = { menuOpen = false; confirmEnd = true })
                        }
                    },
                )
                LDivider()
            }
        },
    ) { padding ->
        // issue 2: consumeWindowInsets stops imePadding re-adding the nav-bar inset the
        // Scaffold padding already applied (with adjustResize, that was the visible gap)
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            if (working && agent?.currentTask != null) {
                Text(
                    "${agent.alias} is working on a task — replies land when the current step wraps up. Your message queues.",
                    style = ltype(LType.Meta),
                    color = p.muted,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = LSpace.l, vertical = LSpace.s),
                )
            }
            LazyColumn(
                modifier = Modifier.weight(1f),
                state = listState,
                contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
                verticalArrangement = Arrangement.spacedBy(LSpace.l),
            ) {
                if (state.turns.isEmpty()) {
                    item {
                        LEmptyState(
                            icon = OrchaIcons.Forum,
                            title = "No conversation yet",
                            message = "Send a message to wake ${agent?.alias ?: "the agent"}.",
                        )
                    }
                    item {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            listOf("What are you working on?", "Any blockers?", "Status update, please").forEach { hint ->
                                LChip(hint, onClick = { draft = hint })
                            }
                        }
                    }
                }
                if (state.turns.size > reveal) {
                    item(key = "conv-load-earlier") {
                        LButton(
                            "Load earlier · showing ${visibleTurns.size} of ${state.turns.size}",
                            { reveal += CONV_REVEAL_STEP },
                            Modifier.fillMaxWidth(),
                            kind = LButtonKind.Ghost,
                            size = LSize.Small,
                        )
                    }
                }
                var lastDay: String? = null
                visibleTurns.forEach { turn ->
                    val day = MobileUx.dayKey(turn.createdAt)
                    if (day != null && day != lastDay) {
                        lastDay = day
                        item(key = "day-$day") { ChatDateSeparator(MobileUx.dayLabel(turn.createdAt) ?: day) }
                    }
                    item(key = turn.id ?: "${turn.seq}") {
                        TurnBubble(
                            turn, state.selectedContainer?.humanAgentId, agent?.alias, onOpenRun, agent?.id,
                            state.snapshot?.tasks.orEmpty(), onOpenTask, workedFor = workedFor[turn.seq],
                        )
                    }
                }
                // Chat send-UX (iOS `ChatSendFlow` parity): pending bubble, awaiting-reply
                // indicator, and the overdue note — see ConversationTurnBubble.kt.
                chatSendFlowItems(
                    sendFlow, agentAlias = agent?.alias, onRetry = { onRetry()?.let { draft = it } },
                    hideAwaiting = liveReply.showing,
                )
                if (liveReply.showing) {
                    item(key = "live-reply") { ChatLiveReplyBlock(liveReply, agent?.alias ?: "agent") }
                }
                if (working && !sendFlow.showsAwaitingReply && !liveReply.showing) {
                    item {
                        Text(
                            "${agent?.alias ?: "The agent"} is working…",
                            style = ltype(LType.Meta),
                            color = p.muted,
                            modifier = Modifier.pulsing(),
                        )
                    }
                }
                if (!sendFlow.isFailed) state.error?.let { item { Banner(BannerKind.Danger, it) } }
            }
            LDivider()
            ChatComposer(
                draft = draft,
                onDraft = { draft = it },
                placeholder = "Message ${agent?.alias ?: "the agent"}…",
                canSend = draft.isNotBlank() && sendFlow.canBegin,
                onSend = { onSend(draft.trim()); draft = "" },
                onMic = if (canDictate) {
                    {
                        speech.launch(
                            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM),
                        )
                    }
                } else null,
            )
        }
    }
    if (confirmEnd) {
        AlertDialog(
            onDismissRequest = { confirmEnd = false },
            title = { Text("End this conversation?") },
            text = { Text("${agent?.alias ?: "The agent"} goes back to their own work. The transcript stays here.") },
            confirmButton = {
                TextButton(onClick = { confirmEnd = false; onEnd() }) { Text("End conversation", color = p.danger, fontWeight = FontWeight.W700) }
            },
            dismissButton = { TextButton(onClick = { confirmEnd = false }) { Text("Cancel", color = p.accent) } },
            containerColor = p.raised,
        )
    }
}

/** Composer: one rounded surface field with mic + circular send inside (web / iOS chat). */
@Composable
private fun ChatComposer(
    draft: String,
    onDraft: (String) -> Unit,
    placeholder: String,
    canSend: Boolean,
    onSend: () -> Unit,
    onMic: (() -> Unit)?,
) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(22.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = LSpace.m, vertical = LSpace.s)
            .background(p.surface, shape)
            .border(1.dp, p.border, shape)
            .padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
            if (draft.isEmpty()) Text(placeholder, style = ltype(LType.Body), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                textStyle = ltype(LType.Body).copy(color = p.text),
                cursorBrush = SolidColor(p.accent),
                maxLines = 5,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder },
            )
        }
        onMic?.let {
            IconButton(onClick = it) { Icon(MicIcon, "Dictate a message", tint = p.muted, modifier = Modifier.size(20.dp)) }
        }
        IconButton(onClick = onSend, enabled = canSend) {
            Box(
                Modifier.size(32.dp).background(if (canSend) p.accent else p.surface2, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(OrchaIcons.Send, "Send", tint = if (canSend) Color.White else p.faint, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** Microphone glyph (24dp viewport) — the icon set has none. */
private val MicIcon: ImageVector by lazy {
    ImageVector.Builder("Mic", 24.dp, 24.dp, 24f, 24f).apply {
        path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // capsule
            moveTo(12f, 3f)
            curveTo(10.34f, 3f, 9f, 4.34f, 9f, 6f)
            lineTo(9f, 12f)
            curveTo(9f, 13.66f, 10.34f, 15f, 12f, 15f)
            curveTo(13.66f, 15f, 15f, 13.66f, 15f, 12f)
            lineTo(15f, 6f)
            curveTo(15f, 4.34f, 13.66f, 3f, 12f, 3f)
            close()
            // cradle
            moveTo(5.5f, 11f)
            curveTo(5.5f, 14.6f, 8.4f, 17.5f, 12f, 17.5f)
            curveTo(15.6f, 17.5f, 18.5f, 14.6f, 18.5f, 11f)
            // stem
            moveTo(12f, 17.5f)
            lineTo(12f, 21f)
        }
    }.build()
}
