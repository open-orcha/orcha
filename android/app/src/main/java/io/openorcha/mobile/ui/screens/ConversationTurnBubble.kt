package io.openorcha.mobile.ui.screens

/** Renders one agent-conversation turn with task-link support. */

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
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
import io.openorcha.mobile.data.ModelDto
import io.openorcha.mobile.data.RunDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.TurnDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.Bubble
import io.openorcha.mobile.ui.components.BubbleKind
import io.openorcha.mobile.ui.components.KVRow
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.SegControl
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.components.pulseAlpha
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 09 — Agent detail (header, Now, Controls, persona, runs) + pickers.
   Flow 10 — Converse (honest presence, bubbles, composer, end confirm).
   ============================================================================= */

@Composable
internal fun TurnBubble(
    turn: TurnDto,
    humanId: String?,
    agentAlias: String?,
    onOpenRun: (RunDto) -> Unit,
    agentId: String?,
    tasks: List<TaskDto>,
    onOpenTask: (String) -> Unit,
) {
    val p = Orcha.palette
    val mine = turn.authorAgentId == humanId || turn.role == "human"
    when {
        turn.role == "system" -> Bubble(BubbleKind.System, turn.content, tasks = tasks, onOpenTask = onOpenTask)
        mine -> Bubble(BubbleKind.Mine, turn.content, time = MobileUx.agoLabel(turn.createdAt), tasks = tasks, onOpenTask = onOpenTask)
        else -> Bubble(
            BubbleKind.Theirs, turn.content, author = agentAlias ?: "agent", time = MobileUx.agoLabel(turn.createdAt),
            tasks = tasks, onOpenTask = onOpenTask,
        ) {
            turn.runId?.let { rid ->
                Text(
                    "Open work log →",
                    style = MaterialTheme.typography.labelMedium,
                    color = p.accent,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .clickable { onOpenRun(RunDto(runId = rid, agentId = agentId, status = "exited")) },
                )
            }
        }
    }
}
