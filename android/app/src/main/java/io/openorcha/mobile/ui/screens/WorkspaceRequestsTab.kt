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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.domain.ExpiryChip
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RequestChip
import io.openorcha.mobile.domain.RequestSort
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.domain.SortKey
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Requests tab (Linear, mirrors ios RequestsTabView.swift): lens pills — "Yours" (the four
   binding groups of flow 07, needs-you-first) + the web's chips (All / Open / Answered /
   To a human / Task reqs) as a flat, sorted, paged list. */

/** Web page size (issue 4): requests.html renders 15/page + "Load more". */
private const val REQUESTS_PAGE = 15

/** The "Yours" lens key; any other lens value is a [RequestChip] name. */
internal const val REQUESTS_LENS_YOURS = "Yours"

/** Pill copy — web parity: the escalations chip reads "To a human". */
internal fun requestLensLabel(chip: RequestChip): String =
    if (chip == RequestChip.Escalations) "To a human" else chip.label

/** Request status → the shared Linear status-glyph vocabulary (iOS `RequestRowCard.glyphStatus`). */
/** The request's own status for the glyph (web `StatusIcon` parity); escalated wins. */
internal fun requestGlyphStatus(status: String, escalated: Boolean): String = if (escalated) "escalated" else status

@Composable
internal fun RequestsTab(
    requests: List<RequestDto>,
    agents: List<AgentDto>,
    humanId: String?,
    onOpenRequest: (String) -> Unit,
) {
    val p = Orcha.palette
    // "Yours" needs to know who you are; paired without an identity (manual address on a
    // multi-human project) it would read "all caught up" while requests wait — open on All.
    var lens by rememberSaveable { mutableStateOf(if (humanId != null) REQUESTS_LENS_YOURS else RequestChip.All.name) }
    var sortKeyName by rememberSaveable { mutableStateOf(SortKey.Time.name) }
    var sortAsc by rememberSaveable { mutableStateOf(false) }
    var shown by rememberSaveable { mutableStateOf(REQUESTS_PAGE) }
    var showDone by rememberSaveable { mutableStateOf(false) }
    val sortKey = SortKey.valueOf(sortKeyName)
    // Reset paging only when the lens or sort really changes, not on the first run after a rotation.
    var pagedFor by rememberSaveable { mutableStateOf("$lens|$sortKeyName|$sortAsc") }
    LaunchedEffect(lens, sortKeyName, sortAsc) {
        val key = "$lens|$sortKeyName|$sortAsc"
        if (key != pagedFor) { pagedFor = key; shown = REQUESTS_PAGE }
    }

    val lensOptions = listOf(REQUESTS_LENS_YOURS to "Yours") + RequestChip.entries.map { it.name to requestLensLabel(it) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(p.bg),
        contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.m),
        verticalArrangement = Arrangement.spacedBy(LSpace.l),
    ) {
        item(key = "req-lens") {
            LSegmented(options = lensOptions, selection = lens, onSelect = { lens = it })
        }
        if (lens == REQUESTS_LENS_YOURS) {
            val groups = MobileUx.requestGroups(requests, humanId)
            listOf(
                "Needs your answer" to groups.needsYourAnswer,
                "Waiting on others" to groups.waitingOnOthers,
                "Answered — act on it" to groups.answeredActOnIt,
            ).filter { it.second.isNotEmpty() }.forEach { (title, list) ->
                item(key = "group-$title") {
                    LSection(title, count = list.size) { RequestPanel(list, agents, humanId, onOpenRequest) }
                }
            }
            val active = groups.needsYourAnswer.size + groups.waitingOnOthers.size + groups.answeredActOnIt.size
            if (groups.done.isNotEmpty()) {
                item(key = "group-done") {
                    val expanded = showDone || active == 0
                    LSection(
                        "Done",
                        count = groups.done.size,
                        trailing = if (active == 0) null else {
                            { LButton(if (showDone) "Hide" else "Show", { showDone = !showDone }, kind = LButtonKind.Ghost, size = LSize.Small) }
                        },
                    ) {
                        if (expanded) RequestPanel(groups.done, agents, humanId, onOpenRequest)
                    }
                }
            }
            if (active == 0 && groups.done.isEmpty()) {
                item {
                    LEmptyState(
                        icon = OrchaIcons.Inbox,
                        title = "You're all caught up",
                        message = "No requests involve you. Tap “All” to see every request.",
                    )
                }
            }
        } else {
            val chip = RequestChip.valueOf(lens)
            val filtered = requests.filter { RequestsView.matchesChip(it, chip, agents) }
            val sorted = RequestsView.sort(filtered, RequestSort(sortKey, sortAsc))
            item(key = "req-sort") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    LChip("Time", selected = sortKey == SortKey.Time, onClick = { sortKeyName = SortKey.Time.name })
                    LChip("Priority", selected = sortKey == SortKey.Priority, onClick = { sortKeyName = SortKey.Priority.name })
                    Spacer(Modifier.weight(1f))
                    LChip(
                        when {
                            sortKey == SortKey.Time && sortAsc -> "Oldest first"
                            sortKey == SortKey.Time -> "Newest first"
                            sortAsc -> "Highest first"
                            else -> "Lowest first"
                        },
                        onClick = { sortAsc = !sortAsc },
                    )
                }
            }
            if (sorted.isEmpty()) {
                item {
                    LEmptyState(
                        icon = OrchaIcons.Inbox,
                        title = if (requests.isEmpty()) "No requests yet" else "Nothing here",
                        message = if (requests.isEmpty()) "No requests in this container yet." else "Nothing matches this filter.",
                    )
                }
            } else {
                item(key = "req-flat") { RequestPanel(sorted.take(shown), agents, humanId, onOpenRequest) }
                if (sorted.size > shown) {
                    item(key = "req-load-more") { LoadMoreRow(shown, sorted.size) { shown += REQUESTS_PAGE } }
                }
            }
        }
        item { Spacer(Modifier.height(72.dp)) }
    }
}

/** One hairline-bordered panel holding a run of request rows. */
@Composable
private fun RequestPanel(list: List<RequestDto>, agents: List<AgentDto>, humanId: String?, onOpenRequest: (String) -> Unit) {
    LCard(padding = 0.dp) {
        list.forEachIndexed { i, req ->
            RequestRow(req, agents, humanId, onOpenRequest)
            if (i != list.lastIndex) LDivider(inset = 60.dp)
        }
    }
}

/** Linear request row: avatar pair, question as title, "from → to" + kind tag, glyph + time. */
@Composable
fun RequestRow(req: RequestDto, agents: List<AgentDto>, humanId: String?, onOpenRequest: (String) -> Unit) {
    val p = Orcha.palette
    val expiry = MobileUx.expiryChip(req.expiresAt)
    // server rows never carry aliases — resolve from snapshot.agents (web data.js:118-119)
    val fromAlias = RequestsView.aliasFor(agents, req.requesterId) ?: req.requesterAlias
    val toAlias = RequestsView.aliasFor(agents, req.targetId) ?: req.targetAlias
    val fromIsYou = req.requesterId == humanId
    val toIsYou = req.targetId == humanId || req.targetId == null
    val fromHuman = fromIsYou || RequestsView.kindFor(agents, req.requesterId) == "human"
    val toHuman = toIsYou || RequestsView.kindFor(agents, req.targetId) == "human"
    val fromLabel = if (fromIsYou) "You" else fromAlias ?: "agent"
    val toLabel = if (toIsYou) "you" else toAlias ?: "agent"
    val escalated = RequestsView.isEscalatedOpen(req, agents)
    // Human text only (agent instructions never shown); an optimistic Resolve reads as closed.
    val human = io.openorcha.mobile.domain.RequestHumanText.humanize(req.payload, req.detail)
    val title = human.title ?: human.body.lineSequence().firstOrNull { it.isNotBlank() } ?: human.body
    val shownStatus = ResolveUndoStore.displayStatus(req)
    val kind = if (req.type == "task") "Task" else "Question"
    val a11y = listOfNotNull(
        "$title. $fromLabel to $toLabel, ${if (req.type == "task") "task request" else "question"}",
        if (escalated) "to a human" else MobileUx.statusCopy(shownStatus),
        MobileUx.agoLabel(req.createdAt),
    ).joinToString(", ")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clickable(role = Role.Button) { onOpenRequest(req.id) }
            .clearAndSetSemantics { contentDescription = a11y }
            .alpha(if (expiry == ExpiryChip.Expired) 0.6f else 1f)
            .padding(horizontal = LSpace.m, vertical = LSpace.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        RequestAvatarPair(
            from = fromAlias ?: fromLabel, fromHuman = fromHuman,
            to = if (req.targetId == null) "Human" else toAlias ?: "A", toHuman = toHuman,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("$fromLabel → $toLabel", style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                LTag(kind)
                if (req.chainDepth > 0) LTag("↳ chain")
                when (expiry) {
                    is ExpiryChip.Warn -> LTag(expiry.label, tint = p.warn)
                    ExpiryChip.Expired -> LTag("Expired", tint = p.danger)
                    null -> Unit
                }
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            LStatusGlyph(requestGlyphStatus(shownStatus, escalated))
            Text(MobileUx.agoLabel(req.createdAt) ?: "", style = ltype(LType.Micro), color = p.faint, maxLines = 1)
        }
    }
}

/** Requester avatar with the target's avatar overlapping bottom-right (web flow avatars). */
@Composable
internal fun RequestAvatarPair(from: String, fromHuman: Boolean, to: String, toHuman: Boolean, size: Int = 32) {
    val p = Orcha.palette
    Box(Modifier.size((size + 6).dp)) {
        LAvatar(from, isAI = !fromHuman, size = size.dp)
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .offset(x = 2.dp, y = 2.dp)
                .border(2.dp, p.surface, CircleShape)
                .padding(2.dp),
        ) {
            LAvatar(to, isAI = !toHuman, size = (size * 0.5f).dp)
        }
    }
}
