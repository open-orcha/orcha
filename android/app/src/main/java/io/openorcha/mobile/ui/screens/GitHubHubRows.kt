package io.openorcha.mobile.ui.screens

/** GitHub hub list rows — Linear rows (Android parity of iOS `GitHubPullRowCard` /
 *  `GitHubIssueRowCard`): state glyph, mono #number + title, one horizontally
 *  scrolling meta line (tags, branch, checks, merge state, avatars), and a trailing
 *  relative time + compact Start. Hairline-separated, no cards. Tap navigates to the
 *  detail; Start opens the start sheet (unassigned or with an agent). */

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.ChecksChip
import io.openorcha.mobile.ui.components.GitHubLabelChip
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.MergeStateChip
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/** Linear PR row: open/draft glyph, #number, title, branch, checks, merge state, reviewers. */
@Composable
fun GitHubPullRowCard(pull: GitHubPullRow, onClick: () -> Unit, onStart: () -> Unit) {
    val p = Orcha.palette
    GitHubHubRow(
        glyphTint = if (pull.draft) p.muted else p.ok,
        pullGlyph = true,
        stateLabel = if (pull.draft) "Draft pull request" else "Open pull request",
        number = pull.number,
        title = pull.title,
        updatedAt = pull.updatedAt,
        onClick = onClick,
        onStart = onStart,
    ) {
        if (pull.draft) LTag("Draft")
        if (!pull.head.isNullOrEmpty()) {
            Text(pull.head, style = ltype(LType.Mono), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // Search-sourced rows lack `checks` entirely — hide the chip rather than
        // showing a false "no checks" pill.
        pull.checks?.let { ChecksChip(it) }
        MergeStateChip(pull.mergeableState)
        val reviewers = pull.requestedReviewers.orEmpty()
        if (reviewers.isNotEmpty()) {
            Row(
                Modifier.semantics(mergeDescendants = true) { contentDescription = "Reviewers: ${reviewers.joinToString(", ")}" },
                horizontalArrangement = Arrangement.spacedBy((-6).dp),
            ) {
                reviewers.take(3).forEach { LAvatar(it, size = 18.dp) }
            }
        }
    }
}

/** Linear issue row: open glyph, #number, title, assignee avatar, labels as tags. */
@Composable
fun GitHubIssueRowCard(issue: GitHubIssueRow, onClick: () -> Unit, onStart: () -> Unit) {
    val p = Orcha.palette
    GitHubHubRow(
        glyphTint = p.ok,
        pullGlyph = false,
        stateLabel = "Open issue",
        number = issue.number,
        title = issue.title,
        updatedAt = issue.updatedAt,
        onClick = onClick,
        onStart = onStart,
    ) {
        issue.assignee?.let { a ->
            Box(Modifier.semantics { contentDescription = "Assigned to $a" }) { LAvatar(a, size = 18.dp) }
        }
        issue.labels.take(3).forEach { GitHubLabelChip(it) }
        if (issue.labels.size > 3) Text("+${issue.labels.size - 3}", style = ltype(LType.Micro), color = p.faint)
        if (issue.assignee == null && issue.labels.isEmpty()) {
            Text("Unassigned", style = ltype(LType.Micro), color = p.faint)
        }
    }
}

@Composable
private fun GitHubHubRow(
    glyphTint: Color,
    pullGlyph: Boolean,
    stateLabel: String,
    number: Int,
    title: String,
    updatedAt: String?,
    onClick: () -> Unit,
    onStart: () -> Unit,
    meta: @Composable () -> Unit,
) {
    val p = Orcha.palette
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick, role = Role.Button)
                .padding(horizontal = LSpace.l, vertical = LSpace.m),
            horizontalArrangement = Arrangement.spacedBy(LSpace.m),
            verticalAlignment = Alignment.Top,
        ) {
            GitHubStateGlyph(glyphTint, pullGlyph, stateLabel, Modifier.padding(top = 2.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("#$number", style = ltype(LType.Mono), color = p.faint, modifier = Modifier.alignByBaseline())
                    Text(
                        title, style = ltype(LType.BodyEmph), color = p.text,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.alignByBaseline(),
                    )
                }
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) { meta() }
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                MobileUx.agoLabel(updatedAt)?.let { ago ->
                    Text(
                        ago, style = ltype(LType.Micro), color = p.faint,
                        modifier = Modifier.semantics { contentDescription = "Updated $ago" },
                    )
                }
                GitHubStartRowButton(onStart)
            }
        }
        LDivider(inset = LSpace.l + 18.dp + LSpace.m)
    }
}

/** Open-issue dot-in-ring / pull-request glyph, drawn so no extended icon set is needed. */
@Composable
internal fun GitHubStateGlyph(tint: Color, pull: Boolean, label: String, modifier: Modifier = Modifier) {
    Box(
        modifier.size(18.dp).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (pull) {
            Icon(OrchaIcons.GitHub, null, tint = tint, modifier = Modifier.size(15.dp))
        } else {
            Box(Modifier.size(14.dp).border(1.5.dp, tint, CircleShape), contentAlignment = Alignment.Center) {
                Box(Modifier.size(4.dp).background(tint, CircleShape))
            }
        }
    }
}

/** The per-row Start control — compact, 48dp hit target; opens the start sheet. */
@Composable
private fun GitHubStartRowButton(onStart: () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(6.dp)
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(onClick = onStart, role = Role.Button)
            .semantics { contentDescription = "Start a task" },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .clip(shape)
                .background(p.surface2, shape)
                .border(1.dp, p.border, shape)
                .padding(horizontal = 9.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(OrchaIcons.PlayArrow, null, tint = p.text2, modifier = Modifier.size(11.dp))
            Text("Start", style = ltype(LType.Micro).copy(fontWeight = FontWeight.SemiBold), color = p.text2)
        }
    }
}
