package io.openorcha.mobile.ui.screens

/** The GitHub hub's Start-with-an-agent picker — Android parity of iOS
 *  `GitHubStartPickerSheet.swift`. "Unassigned" parks a `ready` task Atlas can route;
 *  picking an agent assigns it and fires the wake. */

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubStartSheet(
    kind: GitHubHubKind,
    number: Int,
    agents: List<AgentDto>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (agentId: String?) -> Unit,
) {
    val p = Orcha.palette
    var picked by remember { mutableStateOf<String?>(null) }
    val confirmTitle = agents.firstOrNull { it.id == picked }?.alias?.let { "Start · assign $it" } ?: "Start — unassigned"

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.bg,
        contentColor = p.text,
        shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = LSpace.l)
                .padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "Start ${if (kind == GitHubHubKind.Pulls) "PR" else "issue"} #$number as a task",
                    style = ltype(LType.Headline), color = p.text,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    "Assign an agent to wake it now, or leave it unassigned for the backlog.",
                    style = ltype(LType.Meta), color = p.muted,
                )
            }

            LCard(padding = 0.dp) {
                PickRow(selected = picked == null, title = "Unassigned", sub = "Parked in the backlog", onClick = { picked = null }) {
                    Icon(OrchaIcons.Inbox, contentDescription = null, tint = p.muted, modifier = Modifier.size(20.dp))
                }
            }

            LSection("Agents", count = agents.size) {
                if (agents.isEmpty()) {
                    Text("No AI agents are active in this project yet.", style = ltype(LType.Meta), color = p.faint)
                } else {
                    LCard(padding = 0.dp) {
                        agents.forEachIndexed { i, agent ->
                            if (i > 0) LDivider()
                            PickRow(
                                selected = picked == agent.id,
                                title = agent.alias,
                                sub = MobileUx.statusCopy(agent.status ?: "idle"),
                                onClick = { picked = agent.id },
                            ) { LAvatar(agent.alias, isAI = true, size = 24.dp, status = agent.status) }
                        }
                    }
                }
            }

            LButton(
                confirmTitle, { onConfirm(picked) },
                modifier = Modifier.fillMaxWidth(),
                icon = OrchaIcons.PlayArrow, kind = LButtonKind.Primary, enabled = !busy,
            )
        }
    }
}

@Composable
private fun PickRow(selected: Boolean, title: String, sub: String, onClick: () -> Unit, avatar: @Composable () -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .selectable(selected = selected, onClick = onClick, role = Role.RadioButton)
            .padding(horizontal = LSpace.m, vertical = LSpace.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        avatar()
        Column(Modifier.weight(1f)) {
            Text(title, style = ltype(LType.BodyEmph), color = p.text)
            Text(sub, style = ltype(LType.Meta), color = p.muted)
        }
        if (selected) Icon(OrchaIcons.Check, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
    }
}
