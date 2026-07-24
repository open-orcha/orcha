package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
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
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.RequestStatusPill
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* Requests tab: all container requests + web-parity chips & Time|Priority sort
   (requests.html:88-148, app.js:1600-1673), client-side over the snapshot like web. */

/** Web page size (issue 4): requests.html renders 15/page + "Load more". */
private const val REQUESTS_PAGE = 15

@Composable
internal fun RequestsTab(
    requests: List<RequestDto>,
    agents: List<AgentDto>,
    humanId: String?,
    onOpenRequest: (String) -> Unit,
) {
    val p = Orcha.palette
    // issue 1: the web requests page's five single-select chips + Time|Priority sort
    var chipName by rememberSaveable { mutableStateOf(RequestChip.All.name) }
    var sortKeyName by rememberSaveable { mutableStateOf(SortKey.Time.name) }
    var sortAsc by rememberSaveable { mutableStateOf(false) }
    // issue 4: web-parity render cap (requests.html: 15/page + "Load more")
    var shown by rememberSaveable { mutableStateOf(REQUESTS_PAGE) }
    val chip = RequestChip.valueOf(chipName)
    val sortKey = SortKey.valueOf(sortKeyName)
    LaunchedEffect(chipName, sortKeyName, sortAsc) { shown = REQUESTS_PAGE }

    val filtered = requests.filter { RequestsView.matchesChip(it, chip, agents) }
    val sorted = RequestsView.sort(filtered, RequestSort(sortKey, sortAsc))

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "req-chips") {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(RequestChip.entries, key = { it.name }) { c ->
                    FilterChipText(c.label, on = c == chip) { chipName = c.name }
                }
            }
        }
        item(key = "req-sort") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Sort", style = MaterialTheme.typography.labelMedium, color = p.faint)
                FilterChipText("Time", on = sortKey == SortKey.Time) { sortKeyName = SortKey.Time.name }
                FilterChipText("Priority", on = sortKey == SortKey.Priority) { sortKeyName = SortKey.Priority.name }
                Spacer(Modifier.weight(1f))
                FilterChipText(if (sortAsc) "↑ asc" else "↓ desc", on = true) { sortAsc = !sortAsc }
            }
        }
        items(sorted.take(shown), key = { it.id }) { req -> RequestRow(req, agents, humanId, onOpenRequest) }
        if (sorted.size > shown) {
            item(key = "req-load-more") { LoadMoreRow(shown, sorted.size) { shown += REQUESTS_PAGE } }
        }
        if (sorted.isEmpty()) {
            item {
                OrchaCard {
                    Text(
                        if (requests.isEmpty()) "No requests in this container yet." else "Nothing matches this filter.",
                        color = p.muted,
                    )
                }
            }
        }
        item { Spacer(Modifier.height(72.dp)) }
    }
}

/** Small single-select chip (shared by the requests chips + sort control). */
@Composable
private fun FilterChipText(label: String, on: Boolean, onClick: () -> Unit) {
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

@Composable
fun RequestRow(req: RequestDto, agents: List<AgentDto>, humanId: String?, onOpenRequest: (String) -> Unit) {
    val p = Orcha.palette
    val expiry = MobileUx.expiryChip(req.expiresAt)
    // server rows never carry aliases — resolve from snapshot.agents (web data.js:118-119)
    val fromAlias = RequestsView.aliasFor(agents, req.requesterId) ?: req.requesterAlias
    val toAlias = RequestsView.aliasFor(agents, req.targetId) ?: req.targetAlias
    val fromHuman = req.requesterId == humanId || RequestsView.kindFor(agents, req.requesterId) == "human"
    val toHuman = req.targetId == null || req.targetId == humanId || RequestsView.kindFor(agents, req.targetId) == "human"
    OrchaCard(
        modifier = Modifier.alpha(if (expiry == ExpiryChip.Expired) 0.65f else 1f),
        onClick = { onOpenRequest(req.id) },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Avatar(fromAlias ?: "?", human = fromHuman, size = AvatarSize.Sm)
            Text("→", color = p.faint)
            Avatar(
                if (req.targetId == null) "H" else toAlias ?: "?",
                human = toHuman,
                size = AvatarSize.Sm,
            )
            Text(
                "${if (req.requesterId == humanId) "you" else fromAlias ?: "agent"} → ${if (req.targetId == humanId || req.targetId == null) "you" else toAlias ?: "agent"}",
                style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Text(req.payload, style = MaterialTheme.typography.bodyMedium, color = p.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RequestStatusPill(req.status, escalated = RequestsView.isEscalatedOpen(req, agents))
            MetaTag(req.type)
            if (req.chainDepth > 0) MetaTag("↳ chain")
            when (expiry) {
                is ExpiryChip.Warn -> MetaTag(expiry.label, tint = p.warn)
                ExpiryChip.Expired -> MetaTag("expired", tint = p.danger)
                null -> Unit
            }
            Spacer(Modifier.weight(1f))
            Text(MobileUx.agoLabel(req.createdAt) ?: "", style = MonoSmStyle, color = p.faint)
        }
    }
}
