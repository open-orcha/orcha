package io.openorcha.mobile.ui.screens

/** Agent detail "Reports to" (org chart): the direct manager plus the chain of command. */

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import io.ktor.client.statement.bodyAsText
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.setReportsTo
import io.openorcha.mobile.domain.AgentOrgUx
import io.openorcha.mobile.domain.ConnectionErrorCopy
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LSize
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ChainMemberDto
import io.openorcha.mobile.data.ReportsToDto
import io.openorcha.mobile.data.getReportsTo
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/**
 * GET /api/agents/{aid}/reports-to. The nearest manager is the first row; higher managers
 * follow, each tappable (retired managers are listed but not navigable). Nobody above →
 * a single muted "Reports to nobody" row (web org page copy). Hidden on load failure.
 */
@Composable
internal fun AgentReportsToSection(
    baseUrl: String,
    agentId: String,
    onOpenAgent: ((String) -> Unit)?,
    alias: String = "",
    people: List<AgentDto> = emptyList(),
    containerId: String? = null,
    /** The paired human when they may rewire the org (owner / manage_agents); null hides the action. */
    actorId: String? = null,
) {
    val p = Orcha.palette
    var data by remember(agentId) { mutableStateOf<ReportsToDto?>(null) }
    var picking by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember(agentId) { mutableStateOf<Pair<Boolean, String>?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(baseUrl, agentId) {
        data = runCatching { AgentSliceStore.api.getReportsTo(baseUrl, agentId) }.getOrNull()
    }
    val d = data ?: return
    LSection(
        "Reports to",
        trailing = if (actorId != null && containerId != null) {
            { LButton("Change manager…", { message = null; picking = true }, kind = LButtonKind.Ghost, size = LSize.Small, enabled = !busy) }
        } else null,
    ) {
        LCard(padding = 0.dp) {
            if (d.chain.isEmpty()) {
                LRow(title = "Nobody", subtitle = "Top of the org chart — no manager set")
            } else {
                d.chain.forEachIndexed { i, m ->
                    if (i > 0) LDivider(inset = LSpace.m)
                    ChainRow(m, depth = i, onOpenAgent = onOpenAgent)
                }
            }
        }
        message?.let { (ok, text) ->
            Text(text, style = ltype(LType.Meta), color = if (ok) p.muted else p.danger, modifier = Modifier.padding(top = LSpace.xs))
        }
    }

    if (picking && actorId != null && containerId != null) {
        ManagerPickerSheet(
            baseUrl = baseUrl,
            containerId = containerId,
            agentId = agentId,
            alias = alias,
            currentManagerId = d.reportsToAgentId,
            people = people,
            onDismiss = { picking = false },
        ) { managerId ->
            picking = false
            busy = true
            scope.launch {
                runCatching { AgentSliceStore.api.setReportsTo(baseUrl, agentId, managerId, actorId) }
                    .onSuccess { r ->
                        data = r
                        message = true to AgentOrgUx.changedToast(alias, r.reportsToAlias)
                        AgentSliceStore.refreshOrg(baseUrl, containerId)
                    }
                    .onFailure { err -> message = false to ("Couldn't change the manager — " + reportsToError(err)) }
                busy = false
            }
        }
    }
}

/** The server's 409 loop / 422 retired-manager copy is written for people — show it. */
private suspend fun reportsToError(err: Throwable): String {
    val body = (err as? io.ktor.client.plugins.ResponseException)?.let { runCatching { it.response.bodyAsText() }.getOrNull() }
    val detail = body?.let {
        runCatching {
            (kotlinx.serialization.json.Json.parseToJsonElement(it) as? JsonObject)?.get("detail")?.jsonPrimitive?.content
        }.getOrNull()
    }
    return detail?.takeIf { it.isNotBlank() } ?: ConnectionErrorCopy.friendly(err)
}

/**
 * Pick who [alias] reports to: live humans first, then AI agents — never the agent itself
 * or one of its own reports (that would make a loop; web `managerCandidates`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManagerPickerSheet(
    baseUrl: String,
    containerId: String,
    agentId: String,
    alias: String,
    currentManagerId: String?,
    people: List<AgentDto>,
    onDismiss: () -> Unit,
    onPick: (String?) -> Unit,
) {
    val p = Orcha.palette
    val orgByProject by AgentSliceStore.org.collectAsState()
    LaunchedEffect(baseUrl, containerId) { AgentSliceStore.refreshOrg(baseUrl, containerId) }
    val managerOf = orgByProject[containerId].orEmpty()
    val byId = people.associateBy { it.id }
    val candidates = AgentOrgUx.managerCandidates(
        agentId,
        people.map { AgentOrgUx.Person(it.id, it.kind == "human", it.terminatedAt != null || it.status == "terminated") },
        managerOf,
    ).mapNotNull { byId[it] }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.surface) {
        Column(Modifier.fillMaxWidth().padding(bottom = LSpace.xl)) {
            Text(
                "Who does $alias report to?",
                style = ltype(LType.Headline), color = p.text,
                modifier = Modifier.padding(horizontal = LSpace.l, vertical = LSpace.s),
            )
            Text(
                "Agents that already report to $alias aren't listed — that would make a loop.",
                style = ltype(LType.Meta), color = p.muted,
                modifier = Modifier.padding(horizontal = LSpace.l).padding(bottom = LSpace.s),
            )
            LazyColumn {
                item(key = "none") {
                    PickRow("No manager", "Top of the org chart", null, selected = currentManagerId == null) { onPick(null) }
                }
                items(candidates, key = { it.id }) { a ->
                    val human = a.kind == "human"
                    val name = if (human) a.githubLogin ?: a.alias else a.alias
                    PickRow(name, if (human) "Human" else a.role ?: "AI agent", a, selected = a.id == currentManagerId) {
                        if (a.id != currentManagerId) onPick(a.id) else onDismiss()
                    }
                }
            }
        }
    }
}

@Composable
private fun PickRow(title: String, subtitle: String, agent: AgentDto?, selected: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    LRow(
        title = title,
        subtitle = subtitle,
        onClick = onClick,
        modifier = Modifier.semantics { this.selected = selected },
        leading = agent?.let { a -> { LAvatar(a.alias, isAI = a.kind != "human", size = 24.dp) } },
        trailing = if (selected) {
            { Icon(OrchaIcons.Check, contentDescription = "Current manager", tint = p.accent, modifier = Modifier.size(18.dp)) }
        } else null,
    )
}

@Composable
private fun ChainRow(m: ChainMemberDto, depth: Int, onOpenAgent: ((String) -> Unit)?) {
    val p = Orcha.palette
    val kind = if (m.kind == "human") "Human" else "AI agent"
    val where = if (depth == 0) "Direct manager" else "Manager · $depth level${if (depth == 1) "" else "s"} up"
    val subtitle = listOfNotNull(where, kind, if (m.terminated) "Retired" else null).joinToString(" · ")
    val canOpen = onOpenAgent != null && !m.terminated
    LRow(
        title = m.alias.ifBlank { "Unknown" },
        subtitle = subtitle,
        onClick = if (canOpen) ({ onOpenAgent?.invoke(m.id) }) else null,
        leading = { LAvatar(m.alias, isAI = m.kind != "human", size = 24.dp) },
        trailing = if (canOpen) {
            { Icon(OrchaIcons.ChevronRight, contentDescription = null, tint = p.faint, modifier = Modifier.size(16.dp)) }
        } else null,
    )
}
