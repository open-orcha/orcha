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
import io.openorcha.mobile.ui.components.LinkifiedText
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


/** Builds request identity, payload, timeline, role actions, and operator actions. */
internal fun androidx.compose.foundation.lazy.LazyListScope.RequestDetailContent(
    state: OrchaUiState,
    req: io.openorcha.mobile.data.RequestDto,
    agents: List<io.openorcha.mobile.data.AgentDto>,
    humanId: String?,
    palette: io.openorcha.mobile.ui.theme.OrchaPalette,
    fromAlias: String?,
    toAlias: String?,
    isRequester: Boolean,
    isTarget: Boolean,
    onSheet: (RequestSheet) -> Unit,
    onConfirmOwnerClose: () -> Unit,
    onAcceptTask: (String?) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val p = palette
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
    val knownTasks = state.snapshot?.tasks.orEmpty()
    item { SectionH("Payload") }
    item { OrchaCard { LinkifiedText(req.payload, knownTasks, onOpenTask, color = p.text) } }
    req.response?.let {
        item { SectionH("Response") }
        item { OrchaCard(borderColor = p.okLine) { LinkifiedText(it, knownTasks, onOpenTask, color = p.text2) } }
    }
    req.rejectionReason?.let {
        item { SectionH("Rejection") }
        item { OrchaCard(borderColor = p.dangerLine) { LinkifiedText(it, knownTasks, onOpenTask, color = p.text2) } }
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
                PrimaryButton("Respond", { onSheet(RequestSheet.Respond) }, Modifier.fillMaxWidth(), enabled = !state.actionInFlight)
            }
            if (req.status == "open" && isTarget && req.type == "task") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton("Accept task", { onAcceptTask(null) }, Modifier.weight(1f), enabled = !state.actionInFlight)
                    DangerTonalButton("Reject…", { onSheet(RequestSheet.Reject) }, Modifier.weight(1f), enabled = !state.actionInFlight)
                }
            }
            if (isRequester && req.status == "answered") {
                TonalButton("Convert to task", { onSheet(RequestSheet.Convert) }, Modifier.fillMaxWidth(), enabled = !state.actionInFlight)
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
                        TonalButton("Nudge", { onSheet(RequestSheet.Nudge) }, Modifier.weight(1f), enabled = !state.actionInFlight)
                    }
                    if (ops.showClose) {
                        if (ops.closeNeedsReason) {
                            DangerTonalButton("Close", { onSheet(RequestSheet.CloseWithReason) }, Modifier.weight(1f), enabled = !state.actionInFlight)
                        } else {
                            NeutralButton("Close", { onConfirmOwnerClose() }, Modifier.weight(1f), enabled = !state.actionInFlight)
                        }
                    }
                }
            }
        }
    }
    state.error?.let { item { Banner(BannerKind.Danger, it) } }
}
