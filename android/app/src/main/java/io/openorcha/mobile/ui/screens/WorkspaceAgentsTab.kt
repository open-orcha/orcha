package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.StatusDomain
import io.openorcha.mobile.ui.components.StatusPill
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* Agents tab (flow 09 A1): AI roster + humans section. */

@Composable
internal fun AgentsTab(agents: List<AgentDto>, onOpenAgent: (String) -> Unit) {
    val p = Orcha.palette
    val ai = MobileUx.orderAgents(agents.filter { it.kind == "ai" })
    val humans = agents.filter { it.kind == "human" }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { SectionH("Agents", "${ai.size}") }
        items(ai, key = { it.id }) { agent ->
            val dead = agent.status == "terminated"
            OrchaCard(
                modifier = Modifier.alpha(if (dead) 0.55f else 1f),
                onClick = { onOpenAgent(agent.id) },
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Avatar(agent.alias, human = false)
                    Column(Modifier.weight(1f)) {
                        Text(agent.alias, style = MaterialTheme.typography.titleSmall)
                        Text(agent.role ?: "agent", style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    StatusPill(agent.status ?: "idle", StatusDomain.Agent)
                }
                if (agent.status == "working") {
                    agent.currentTask?.title?.let {
                        Text("▸ $it", style = MaterialTheme.typography.bodyMedium, color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    agent.model?.let { MetaTag(it, mono = true) }
                    Spacer(Modifier.weight(1f))
                    Text(MobileUx.agoLabel(agent.lastActive) ?: "", style = MonoSmStyle, color = p.faint)
                }
            }
        }
        if (humans.isNotEmpty()) {
            item { SectionH("Humans", "${humans.size}") }
            items(humans, key = { it.id }) { h ->
                OrchaCard(onClick = { onOpenAgent(h.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(h.alias, human = true)
                        Column(Modifier.weight(1f)) {
                            Text(h.alias, style = MaterialTheme.typography.titleSmall)
                            Text("Human authority", style = MaterialTheme.typography.bodyMedium, color = p.muted)
                        }
                    }
                }
            }
        }
        if (ai.isEmpty() && humans.isEmpty()) {
            item { OrchaCard { Text("No agents yet — create agents from the portal's onboarding.", color = p.muted) } }
        }
    }
}
