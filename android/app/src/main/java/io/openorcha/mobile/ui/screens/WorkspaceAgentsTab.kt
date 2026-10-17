package io.openorcha.mobile.ui.screens

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Agents tab (flow 09 A1), Linear: "AI agents N" / "Humans N" muted captions over one
   grouped hairline panel each; rows are avatar (✦ + presence), name, one meta line,
   status capsule. Mirrors ios AgentsTabView.swift. */

/** Agent status → capsule copy (iOS `AgentStatusCapsule.label`). */
internal fun agentStatusLabel(status: String): String = when (status) {
    "working" -> "Working"
    "waiting", "blocked", "awaiting_request" -> "Waiting"
    "awaiting_human" -> "Needs you"
    "idle" -> "Idle"
    "offline" -> "Offline"
    "retired", "terminated" -> "Retired"
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** Compact agent status capsule ("Working", "Waiting", "Needs you"…), tinted by state. */
@Composable
internal fun AgentStatusCapsule(status: String, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val tint = when (status) {
        "working" -> p.accent
        "waiting", "blocked", "awaiting_request" -> p.warn
        "awaiting_human" -> p.warn
        "retired", "terminated", "offline" -> p.faint
        else -> p.muted
    }
    Row(
        modifier
            .background(p.surface2, CircleShape)
            .border(1.dp, p.border, CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(6.dp).background(tint, CircleShape))
        Text(agentStatusLabel(status), style = ltype(LType.Micro), color = if (status == "working") p.text else p.text2, maxLines = 1)
    }
}

@Composable
internal fun AgentsTab(
    agents: List<AgentDto>,
    onOpenAgent: (String) -> Unit,
    baseUrl: String? = null,
    containerId: String? = null,
) {
    val p = Orcha.palette
    // Budget hard stops (GET /api/containers/{cid}/budgets): a paused agent's row says so.
    // Without a container key the chips still show what agent-detail visits have loaded.
    androidx.compose.runtime.LaunchedEffect(baseUrl, containerId) {
        if (baseUrl != null && containerId != null) io.openorcha.mobile.ui.AgentSliceStore.refreshContainer(baseUrl, containerId)
    }
    val budgets by io.openorcha.mobile.ui.AgentSliceStore.budgets.collectAsState()
    val ai = MobileUx.orderAgents(agents.filter { it.kind == "ai" })
    val humans = agents.filter { it.kind == "human" }
    var mode by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(AgentsRosterMode.Roster) }
    val orgByProject by io.openorcha.mobile.ui.AgentSliceStore.org.collectAsState()
    androidx.compose.runtime.LaunchedEffect(baseUrl, containerId, mode) {
        if (mode == AgentsRosterMode.Org && baseUrl != null && containerId != null) {
            io.openorcha.mobile.ui.AgentSliceStore.refreshOrg(baseUrl, containerId)
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(p.bg),
        contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
        verticalArrangement = Arrangement.spacedBy(LSpace.xl),
    ) {
        if (containerId != null && (ai.isNotEmpty() || humans.isNotEmpty())) {
            item(key = "roster-mode") {
                io.openorcha.mobile.ui.components.LSegmented(
                    options = listOf(AgentsRosterMode.Roster to "Roster", AgentsRosterMode.Org to "Org"),
                    selection = mode,
                    onSelect = { mode = it },
                )
            }
        }
        if (mode == AgentsRosterMode.Org && containerId != null) {
            val managerOf = orgByProject[containerId]
            item(key = "org") {
                AgentsOrgPanel(
                    humans = humans,
                    ai = ai,
                    managerOf = managerOf,
                    budgets = budgets,
                    onOpenAgent = onOpenAgent,
                )
            }
            item { Spacer(Modifier.height(72.dp)) }
            return@LazyColumn
        }
        if (ai.isNotEmpty()) {
            item(key = "ai-agents") {
                LSection("AI agents", count = ai.size) {
                    LCard(padding = 0.dp) {
                        ai.forEachIndexed { i, agent ->
                            AgentRosterRow(agent, budgetPaused = budgets[agent.id]?.paused == true) { onOpenAgent(agent.id) }
                            if (i != ai.lastIndex) LDivider(inset = 56.dp)
                        }
                    }
                }
            }
        }
        if (humans.isNotEmpty()) {
            item(key = "humans") {
                LSection("Humans", count = humans.size) {
                    LCard(padding = 0.dp) {
                        humans.forEachIndexed { i, h ->
                            HumanRosterRow(h) { onOpenAgent(h.id) }
                            if (i != humans.lastIndex) LDivider(inset = 56.dp)
                        }
                    }
                }
            }
        }
        if (ai.isEmpty() && humans.isEmpty()) {
            item {
                LEmptyState(
                    icon = OrchaIcons.SmartToy,
                    title = "No agents yet",
                    message = "Create agents from the portal's onboarding.",
                )
            }
        }
        item { Spacer(Modifier.height(72.dp)) }
    }
}

@Composable
private fun AgentRosterRow(agent: AgentDto, budgetPaused: Boolean = false, onClick: () -> Unit) {
    val p = Orcha.palette
    val dead = agent.status == "terminated" || agent.terminatedAt != null
    val status = if (dead) "retired" else agent.status ?: "idle"
    val currentTitle = agent.activeRun?.taskTitle ?: agent.currentTask?.title
    val working = agent.status == "working" && currentTitle != null
    val meta = listOfNotNull(agent.role ?: "agent", MobileUx.agoLabel(agent.lastActive)).joinToString(" · ")
    val a11y = buildList {
        add(agent.alias); add("AI agent"); add(agentStatusLabel(status))
        if (budgetPaused && !dead) add("Budget paused")
        if (working) add("working on $currentTitle") else agent.role?.let { add(it) }
        io.openorcha.mobile.domain.providerFor(agent.model)?.let { add(it.label) }
    }.joinToString(", ")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = a11y }
            .alpha(if (dead) 0.55f else 1f)
            .padding(horizontal = LSpace.m, vertical = LSpace.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        LAvatar(agent.alias, isAI = true, size = 32.dp, status = status)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(agent.alias, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (working) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    LStatusGlyph("in_progress", size = 11.dp)
                    Text(currentTitle.orEmpty(), style = ltype(LType.Meta), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    io.openorcha.mobile.ui.components.ModelProviderMark(agent.model, size = 12.dp)
                    Text(meta, style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (budgetPaused && !dead) BudgetPausedCapsule() else AgentStatusCapsule(status)
    }
}

@Composable
private fun HumanRosterRow(human: AgentDto, onClick: () -> Unit) {
    val p = Orcha.palette
    val name = human.githubLogin ?: human.alias
    val subtitle = if (human.githubLogin != null && human.githubLogin != human.alias) "${human.alias} · Human authority" else "Human authority"
    val role = humanRoleTag(human)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(horizontal = LSpace.m, vertical = LSpace.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        LAvatar(name, isAI = false, size = 32.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        role?.let { io.openorcha.mobile.ui.components.LTag(it, tint = if (it == "Owner") p.violet else null, dot = it == "Owner") }
    }
}

/**
 * Member role tag (Owner / Member / Viewer). Android's [AgentDto] doesn't carry the
 * server's `member_role` yet, so the tag reads the human's `role` field when it names one
 * of the three membership roles; otherwise no tag (never a guessed role).
 */
internal fun humanRoleTag(human: AgentDto): String? =
    (human.memberRole ?: human.role)?.lowercase()?.takeIf { it in setOf("owner", "member", "viewer") }?.replaceFirstChar { it.uppercase() }

internal enum class AgentsRosterMode { Roster, Org }

/**
 * Agents tab "Org": the reporting lines as an indented tree (web `/org` parity, read-only)
 * — each agent under its manager from the snapshot's `reports_to`.
 */
@Composable
private fun AgentsOrgPanel(
    humans: List<AgentDto>,
    ai: List<AgentDto>,
    managerOf: Map<String, String>?,
    budgets: Map<String, io.openorcha.mobile.data.AgentBudgetDto>,
    onOpenAgent: (String) -> Unit,
) {
    val p = Orcha.palette
    val byId = (humans + ai).associateBy { it.id }
    val nodes = io.openorcha.mobile.domain.AgentOrgUx.flatten((humans + ai).map { it.id }, managerOf.orEmpty())
    Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
        if (managerOf != null && managerOf.isEmpty()) {
            Text(
                "No reporting lines yet — set who an agent reports to from its \"Reports to\" section.",
                style = ltype(LType.Meta), color = p.muted,
            )
        }
        LCard(padding = 0.dp) {
            nodes.forEachIndexed { i, node ->
                val a = byId[node.id] ?: return@forEachIndexed
                if (i > 0) LDivider(inset = 56.dp)
                Box(Modifier.padding(start = (minOf(node.depth, 4) * 18).dp)) {
                    if (a.kind == "ai") {
                        AgentRosterRow(a, budgetPaused = budgets[a.id]?.paused == true) { onOpenAgent(a.id) }
                    } else {
                        HumanRosterRow(a) { onOpenAgent(a.id) }
                    }
                }
            }
        }
    }
}
