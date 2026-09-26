package io.openorcha.mobile.ui.screens

/** Owns request-detail navigation, action-sheet routing, and owner-close confirmation. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.LinkifiedText
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.RequestStatusPill
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 07 — Request detail: flow header, chain context, payload, response quote,
   timeline, and the state×role action matrix. Actions run through bottom sheets.
   ============================================================================= */

internal enum class RequestSheet { None, Respond, Reject, Convert, Nudge, CloseWithReason }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestDetailScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onRespond: (String) -> Unit,
    onClose: (String?) -> Unit,
    onNudge: (String?) -> Unit,
    onEscalate: (String?) -> Unit,
    onAcceptTask: (String?) -> Unit,
    onRejectTask: (String) -> Unit,
    onConvert: (String, String, String?, Int) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val p = Orcha.palette
    val req = state.selectedRequest
    val humanId = state.selectedContainer?.humanAgentId
    // server rows never carry aliases — resolve from snapshot.agents (web data.js:118-119)
    val agents = state.snapshot?.agents.orEmpty()
    val fromAlias = RequestsView.aliasFor(agents, req?.requesterId) ?: req?.requesterAlias
    val toAlias = RequestsView.aliasFor(agents, req?.targetId) ?: req?.targetAlias
    var sheet by remember { mutableStateOf(RequestSheet.None) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmOwnerClose by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("Request") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back") } },
                actions = {
                    if (req != null) {
                        // Escalate is the only overflow action left — Nudge + Close now live in
                        // the universal operator tier below (flow 07a). The daemon-only
                        // "Triage-close" is retired; a stale request is closed with a reason.
                        val isRequester = req.requesterId == humanId
                        if (req.status in setOf("open", "answered") && isRequester) {
                            IconButton(onClick = { menuOpen = true }) { Icon(OrchaIcons.MoreVert, "More") }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                DropdownMenuItem(text = { Text("Escalate") }, onClick = { menuOpen = false; onEscalate(null) })
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (req == null) {
            OrchaCard(Modifier.padding(padding).padding(16.dp)) { Text("Request not found — refresh the workspace.", color = p.muted) }
            return@Scaffold
        }
        val isRequester = req.requesterId == humanId
        val isTarget = req.targetId == humanId || req.targetId == null

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            RequestDetailContent(
                state = state, req = req, agents = agents, humanId = humanId,
                palette = p,
                fromAlias = fromAlias, toAlias = toAlias,
                isRequester = isRequester, isTarget = isTarget,
                onSheet = { sheet = it },
                onConfirmOwnerClose = { confirmOwnerClose = true },
                onAcceptTask = onAcceptTask, onOpenTask = onOpenTask,
            )
        }

        when (sheet) {
            RequestSheet.Respond -> TextSheet(
                kicker = "RESPOND", title = req.payload, label = "Your answer", required = true,
                confirm = "Respond", busy = state.actionInFlight,
                onDismiss = { sheet = RequestSheet.None },
            ) { sheet = RequestSheet.None; onRespond(it) }
            RequestSheet.Reject -> TextSheet(
                kicker = "REJECT TASK REQUEST", title = req.payload, label = "Why not? (required)", required = true,
                confirm = "Reject", busy = state.actionInFlight, destructive = true,
                onDismiss = { sheet = RequestSheet.None },
            ) { sheet = RequestSheet.None; onRejectTask(it) }
            RequestSheet.Nudge -> {
                val who = (if (req.status == "open") toAlias else fromAlias) ?: "the other agent"
                val routed = if (req.status == "open") {
                    "Wakes $who — they still owe an answer."
                } else {
                    "Wakes $who — they must act on the answer or close it."
                }
                TextSheet(
                    kicker = "NUDGE", title = routed, label = "Note (optional)", required = false,
                    confirm = "Nudge", busy = state.actionInFlight,
                    onDismiss = { sheet = RequestSheet.None },
                ) { sheet = RequestSheet.None; onNudge(it.ifBlank { null }) }
            }
            RequestSheet.CloseWithReason -> TextSheet(
                kicker = "CLOSE REQUEST", title = "Closing someone else's request needs a reason.",
                label = "Reason — sent to ${fromAlias ?: "the owner"}", required = true,
                confirm = "Close", busy = state.actionInFlight, destructive = true,
                onDismiss = { sheet = RequestSheet.None },
            ) { sheet = RequestSheet.None; onClose(it) }
            RequestSheet.Convert -> ConvertSheet(
                busy = state.actionInFlight,
                agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null }.map { it.alias },
                onDismiss = { sheet = RequestSheet.None },
            ) { title, dod, assignee -> sheet = RequestSheet.None; onConvert(title, dod, assignee, 100) }
            RequestSheet.None -> Unit
        }

        // Owner close (your own request) — a quick confirm, no reason needed (flow 07a §5).
        if (confirmOwnerClose) {
            AlertDialog(
                onDismissRequest = { confirmOwnerClose = false },
                title = { Text("Close this request?") },
                text = { Text("${toAlias ?: "The other party"} sees it closed on the next sync.") },
                confirmButton = { TextButton(onClick = { confirmOwnerClose = false; onClose(null) }) { Text("Close") } },
                dismissButton = { TextButton(onClick = { confirmOwnerClose = false }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
internal fun TimelineDot(label: String, at: String?, reached: Boolean) {
    val p = Orcha.palette
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 3.dp)) {
        Box(Modifier.size(9.dp).background(if (reached) p.accent else p.border2, CircleShape))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (reached) p.text else p.faint)
        Spacer(Modifier.weight(1f))
        Text(MobileUx.agoLabel(at) ?: "", style = MonoSmStyle, color = p.faint)
    }
}

/** Shared one-field bottom sheet (respond / reject / nudge / close-with-reason). */
