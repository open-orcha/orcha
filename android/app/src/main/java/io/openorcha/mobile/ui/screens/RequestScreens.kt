package io.openorcha.mobile.ui.screens

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.MoreVert
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
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.RequestStatusPill
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 07 — Request detail: flow header, chain context, payload, response quote,
   timeline, and the state×role action matrix. Actions run through bottom sheets.
   ============================================================================= */

private enum class RequestSheet { None, Respond, Reject, Convert, Nudge, CloseWithReason }

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
        containerColor = p.bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = { Text("Request") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    if (req != null) {
                        // Escalate is the only overflow action left — Nudge + Close now live in
                        // the universal operator tier below (flow 07a). The daemon-only
                        // "Triage-close" is retired; a stale request is closed with a reason.
                        val isRequester = req.requesterId == humanId
                        if (req.status in setOf("open", "answered") && isRequester) {
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Rounded.MoreVert, "More") }
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
            item {
                OrchaCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(fromAlias ?: "?", human = req.requesterId == humanId || RequestsView.kindFor(agents, req.requesterId) == "human")
                        Text("→", color = p.faint, style = MaterialTheme.typography.titleMedium)
                        Avatar(
                            if (req.targetId == null) "H" else toAlias ?: "?",
                            human = isTarget || RequestsView.kindFor(agents, req.targetId) == "human",
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                "${if (isRequester) "you" else fromAlias ?: "agent"} → ${if (isTarget) "you" else toAlias ?: "agent"}",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                listOfNotNull(req.type, MobileUx.agoLabel(req.createdAt)?.let { "opened $it" }).joinToString(" · "),
                                style = MaterialTheme.typography.bodyMedium, color = p.muted,
                            )
                        }
                        RequestStatusPill(req.status, escalated = RequestsView.isEscalatedOpen(req, agents))
                    }
                }
            }
            req.parentRequestId?.let {
                item { OrchaCard { Text("↳ part of a request chain (depth ${req.chainDepth})", color = p.muted, style = MaterialTheme.typography.bodyMedium) } }
            }
            req.taskLink?.taskId?.let { tid ->
                item {
                    OrchaCard(onClick = { onOpenTask(tid) }) {
                        Text("SPAWNED TASK →", style = MaterialTheme.typography.labelMedium, color = p.violet)
                        Text(req.taskLink.title ?: tid, style = MaterialTheme.typography.titleSmall)
                    }
                }
            }
            item { SectionH("Payload") }
            item { OrchaCard { Text(req.payload, color = p.text) } }
            req.response?.let {
                item { SectionH("Response") }
                item { OrchaCard(borderColor = p.okLine) { Text(it, color = p.text2) } }
            }
            req.rejectionReason?.let {
                item { SectionH("Rejection") }
                item { OrchaCard(borderColor = p.dangerLine) { Text(it, color = p.text2) } }
            }
            item { SectionH("Timeline") }
            item {
                OrchaCard {
                    TimelineDot("created", req.createdAt, true)
                    if (req.status in setOf("accepted", "answered", "closed", "converted_to_task")) TimelineDot("accepted", null, req.status != "open")
                    if (req.respondedAt != null || req.status in setOf("answered", "closed", "converted_to_task")) TimelineDot("answered", req.respondedAt, true)
                    if (req.closedAt != null || req.status in setOf("closed", "rejected", "converted_to_task")) TimelineDot(MobileUx.statusCopy(req.status), req.closedAt, true)
                }
            }
            // Action zone (flow 07a): role-specific "Your move" on top, then the universal
            // operator tier (Nudge · Close) that lights up on any request the human can see.
            item {
                val ops = RequestsView.operatorActions(req, humanId)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // ── Your move (role-specific) ──
                    if (req.status == "open" && isTarget && req.type == "info") {
                        PrimaryButton("Respond", { sheet = RequestSheet.Respond }, Modifier.fillMaxWidth(), enabled = !state.actionInFlight)
                    }
                    if (req.status == "open" && isTarget && req.type == "task") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PrimaryButton("Accept task", { onAcceptTask(null) }, Modifier.weight(1f), enabled = !state.actionInFlight)
                            DangerTonalButton("Reject…", { sheet = RequestSheet.Reject }, Modifier.weight(1f), enabled = !state.actionInFlight)
                        }
                    }
                    if (isRequester && req.status == "answered") {
                        TonalButton("Convert to task", { sheet = RequestSheet.Convert }, Modifier.fillMaxWidth(), enabled = !state.actionInFlight)
                    }

                    // ── Operator actions (universal) ──
                    if (ops.showOperatorNote) {
                        Banner(
                            BannerKind.Info,
                            "Acting as operator (${state.selectedContainer?.humanAlias ?: "you"}). " +
                                "Closing another agent's request needs a reason — it's sent to the owner so they know why.",
                        )
                    }
                    if (ops.showNudge || ops.showClose) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (ops.showNudge) {
                                TonalButton("Nudge", { sheet = RequestSheet.Nudge }, Modifier.weight(1f), enabled = !state.actionInFlight)
                            }
                            if (ops.showClose) {
                                if (ops.closeNeedsReason) {
                                    DangerTonalButton("Close", { sheet = RequestSheet.CloseWithReason }, Modifier.weight(1f), enabled = !state.actionInFlight)
                                } else {
                                    NeutralButton("Close", { confirmOwnerClose = true }, Modifier.weight(1f), enabled = !state.actionInFlight)
                                }
                            }
                        }
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, it) } }
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
private fun TimelineDot(label: String, at: String?, reached: Boolean) {
    val p = Orcha.palette
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 3.dp)) {
        Box(Modifier.size(9.dp).background(if (reached) p.accent else p.border2, CircleShape))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (reached) p.text else p.faint)
        Spacer(Modifier.weight(1f))
        Text(MobileUx.agoLabel(at) ?: "", style = MonoSmStyle, color = p.faint)
    }
}

/** Shared one-field bottom sheet (respond / reject / nudge / close-with-reason). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TextSheet(
    kicker: String,
    title: String,
    label: String,
    required: Boolean,
    confirm: String,
    busy: Boolean,
    destructive: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val p = Orcha.palette
    var text by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        // A1: a multi-thousand-char payload must never push the field/buttons out of
        // reach — cap the title (full body stays on the detail screen behind the sheet),
        // make the sheet scrollable, and keep it above the keyboard.
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 30.dp)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(kicker, style = MaterialTheme.typography.labelMedium, color = if (destructive) p.danger else p.accent)
            Text(title, style = MaterialTheme.typography.titleSmall, color = p.text2, maxLines = 4, overflow = TextOverflow.Ellipsis)
            OrchaField(text, { text = it }, label = label, minLines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (destructive) {
                    DangerTonalButton(confirm, { onConfirm(text.trim()) }, Modifier.weight(1f), enabled = (!required || text.isNotBlank()) && !busy)
                } else {
                    PrimaryButton(confirm, { onConfirm(text.trim()) }, Modifier.weight(1f), enabled = (!required || text.isNotBlank()) && !busy)
                }
                NeutralButton("Cancel", onDismiss, enabled = !busy)
            }
        }
    }
}

/** Convert-to-task sheet: Title + DoD + assignee, same validation as Create task. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConvertSheet(
    busy: Boolean,
    agents: List<String>,
    onDismiss: () -> Unit,
    onConfirm: (String, String, String?) -> Unit,
) {
    val p = Orcha.palette
    var title by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        // A1: same scroll guard as TextSheet — field + button stay reachable with keyboard open
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 30.dp)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("CONVERT TO TASK", style = MaterialTheme.typography.labelMedium, color = p.violet)
            OrchaField(title, { title = it }, label = "Task title")
            OrchaField(dod, { dod = it }, label = "Definition of done", minLines = 3)
            SectionH("Assign to", assignee ?: "unassigned")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    AssigneeChip("Unassigned", assignee == null) { assignee = null }
                }
                items(agents.size) { i ->
                    AssigneeChip(agents[i], assignee == agents[i]) { assignee = agents[i] }
                }
            }
            PrimaryButton(
                "Convert", { onConfirm(title.trim(), dod.trim(), assignee) },
                Modifier.fillMaxWidth(),
                enabled = title.isNotBlank() && dod.isNotBlank() && !busy,
            )
        }
    }
}

@Composable
fun AssigneeChip(label: String, on: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    Text(
        label,
        modifier = Modifier
            .background(if (on) p.accentSoft else p.surface2, RoundedCornerShape(999.dp))
            .border(BorderStroke(1.dp, if (on) p.accentLine else p.border), RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.W600),
        color = if (on) p.accent else p.muted,
    )
}
