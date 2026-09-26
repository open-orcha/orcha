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
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.SectionH
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

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("START AS A TASK", style = MaterialTheme.typography.labelMedium, color = p.violet)
            Text(
                "Turn ${if (kind == GitHubHubKind.Pulls) "PR" else "issue"} #$number into an Orcha task. " +
                    "Assign an agent to wake it now, or leave it unassigned for the backlog.",
                style = MaterialTheme.typography.bodyMedium, color = p.muted,
            )

            PickRow(selected = picked == null, title = "Unassigned", sub = "Parked in the backlog", onClick = { picked = null }) {
                Icon(OrchaIcons.Inbox, contentDescription = null, tint = p.muted)
            }

            SectionH("Agents", "${agents.size}")
            if (agents.isEmpty()) {
                Text("No AI agents are active in this Orcha yet.", style = MaterialTheme.typography.bodyMedium, color = p.faint)
            }
            agents.forEach { agent ->
                PickRow(
                    selected = picked == agent.id,
                    title = agent.alias,
                    sub = MobileUx.statusCopy(agent.status ?: "idle"),
                    onClick = { picked = agent.id },
                ) { Avatar(agent.alias, human = false, size = AvatarSize.Md) }
            }

            PrimaryButton(confirmTitle, { onConfirm(picked) }, Modifier.fillMaxWidth(), enabled = !busy)
        }
    }
}

@Composable
private fun PickRow(selected: Boolean, title: String, sub: String, onClick: () -> Unit, avatar: @Composable () -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RadioButton(selected = selected, onClick = onClick, colors = RadioButtonDefaults.colors(selectedColor = p.accent, unselectedColor = p.border2))
        avatar()
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.W600))
            Text(sub, style = MaterialTheme.typography.bodyMedium, color = p.muted)
        }
    }
}
