package io.openorcha.mobile.ui.components

/** Shared GitHub-hub chips — used by both the list rows and the detail headers so the
 *  checks summary, merge-state, and per-run glyphs read identically everywhere. Android
 *  parity of iOS `GitHubHubChips.swift`. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.GitHubCheckRun
import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubLabel
import io.openorcha.mobile.domain.ChecksSummary
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/** The compact CI verdict chip ("3✓ 2✗ 2•" tinted by the dominant state). Hidden when
 *  there are no checks at all, unless [showsWhenEmpty]. */
@Composable
fun ChecksChip(checks: GitHubChecks, modifier: Modifier = Modifier, showsWhenEmpty: Boolean = false) {
    val summary = GitHubHubUx.checksSummary(checks)
    if (!summary.hasChecks && !showsWhenEmpty) return
    val tint = verdictColor(summary.verdict)
    Row(
        modifier
            .background(tint.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
            .border(BorderStroke(1.dp, tint.copy(alpha = 0.34f)), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(verdictIcon(summary.verdict), contentDescription = null, tint = tint, modifier = Modifier.size(9.dp))
        Text(
            summary.label,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W600, fontSize = 10.5.sp),
            color = tint,
        )
    }
}

@Composable
private fun verdictColor(verdict: ChecksSummary.Verdict): Color {
    val p = Orcha.palette
    return when (verdict) {
        ChecksSummary.Verdict.Failing -> p.danger
        ChecksSummary.Verdict.Pending -> p.warn
        ChecksSummary.Verdict.Passing -> p.ok
        ChecksSummary.Verdict.None -> p.muted
    }
}

private fun verdictIcon(verdict: ChecksSummary.Verdict) = when (verdict) {
    ChecksSummary.Verdict.Failing -> OrchaIcons.Close
    ChecksSummary.Verdict.Pending -> OrchaIcons.Schedule
    ChecksSummary.Verdict.Passing -> OrchaIcons.Verified
    ChecksSummary.Verdict.None -> OrchaIcons.Circle
}

/** The merge-state chip — tinted green when clean, red on conflicts/blocked, amber
 *  otherwise. Renders nothing when GitHub reports no meaningful state. */
@Composable
fun MergeStateChip(mergeableState: String?, modifier: Modifier = Modifier) {
    val label = GitHubHubUx.mergeStateLabel(mergeableState) ?: return
    val p = Orcha.palette
    val tint = when (mergeableState) {
        "clean" -> p.ok
        "dirty", "blocked", "behind" -> p.danger
        else -> p.warn
    }
    Text(
        label,
        modifier = modifier
            .border(BorderStroke(1.dp, tint.copy(alpha = 0.4f)), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.W500, fontSize = 10.5.sp),
        color = tint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A single GitHub label chip (issue/PR label names). */
@Composable
fun GitHubLabelChip(label: GitHubLabel, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    // Real repo label colors when the server sends them (bare hex, no '#');
    // the house violet is the fallback for colorless labels / older servers.
    val hex = label.color?.toLongOrNull(16)
    val tint = if (hex != null) Color(0xFF000000 or hex) else p.violet
    Text(
        label.name,
        modifier = modifier
            .background(tint.copy(alpha = 0.15f), CircleShape)
            .border(BorderStroke(1.dp, tint.copy(alpha = 0.4f)), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.W500, fontSize = 10.sp),
        color = tint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** The per-run status glyph for the detail checks list. */
@Composable
fun CheckRunGlyph(run: GitHubCheckRun, modifier: Modifier = Modifier) {
    val verdict = GitHubHubUx.runVerdict(run)
    val p = Orcha.palette
    val (icon, color) = when (verdict) {
        ChecksSummary.Verdict.Failing -> OrchaIcons.Close to p.danger
        ChecksSummary.Verdict.Pending -> OrchaIcons.Schedule to p.warn
        ChecksSummary.Verdict.Passing -> OrchaIcons.Check to p.ok
        ChecksSummary.Verdict.None -> OrchaIcons.Circle to p.muted
    }
    Icon(icon, contentDescription = verdictAccessibilityLabel(verdict), tint = color, modifier = modifier)
}

private fun verdictAccessibilityLabel(verdict: ChecksSummary.Verdict): String = when (verdict) {
    ChecksSummary.Verdict.Failing -> "failing"
    ChecksSummary.Verdict.Pending -> "pending"
    ChecksSummary.Verdict.Passing -> "passed"
    ChecksSummary.Verdict.None -> "unknown"
}
