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
    val p = Orcha.palette
    val shape = RoundedCornerShape(p.radiusTag.dp)
    Row(
        modifier
            .background(p.surface2, shape)
            .border(BorderStroke(1.dp, p.border), shape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(verdictIcon(summary.verdict), contentDescription = null, tint = tint, modifier = Modifier.size(10.dp))
        Text(summary.label, style = ltype(LType.Mono).copy(fontSize = 11.sp), color = p.text2)
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
    LTag(label, modifier = modifier, tint = tint, dot = true)
}

/** Issue / PR state as a compact Linear tag: open (green dot), draft (grey), merged
 *  (violet), closed (red). Replaces the task-domain StatusPill on GitHub screens. */
@Composable
fun GitHubStateTag(state: String?, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val s = state?.lowercase().orEmpty()
    val tint = when (s) {
        "open" -> p.ok
        "merged" -> p.violet
        "closed" -> p.danger
        else -> p.muted
    }
    LTag(s.replaceFirstChar { it.uppercase() }.ifEmpty { "Unknown" }, modifier = modifier, tint = tint, dot = true)
}

/** Linear "+N −N" diff count, mono, green/red. */
@Composable
fun DiffCount(additions: Int, deletions: Int, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("+$additions", style = ltype(LType.Mono), color = p.ok)
        Text("\u2212$deletions", style = ltype(LType.Mono), color = p.danger)
    }
}

/** A single GitHub label chip (issue/PR label names). */
@Composable
fun GitHubLabelChip(label: GitHubLabel, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    // Real repo label colors when the server sends them (bare hex, no '#');
    // the house violet is the fallback for colorless labels / older servers.
    val hex = label.color?.toLongOrNull(16)
    val tint = if (hex != null) Color(0xFF000000 or hex) else p.violet
    // Linear label: neutral tag with the label's colour as a dot.
    LTag(label.name, modifier = modifier, tint = tint, dot = true)
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
