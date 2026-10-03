package io.openorcha.mobile.ui.screens

/**
 * Task-detail parity sections (web PR #270): goal ancestry breadcrumb, the proof-of-work
 * evidence pack inside the verification card, the Verdikt result, and the AI manager's
 * pre-review note. All read-only except "Run in Verdikt", which the web exposes to humans.
 */

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.EvidencePackDto
import io.openorcha.mobile.data.GoalChainDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.VerdiktRunDto
import io.openorcha.mobile.data.VerdiktSettingsDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.TaskInsightsUx
import io.openorcha.mobile.domain.TaskInsightsUx.Tone
import io.openorcha.mobile.ui.TaskInsightsState
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@Composable
internal fun toneColor(tone: Tone): Color {
    val p = Orcha.palette
    return when (tone) {
        Tone.Ok -> p.ok
        Tone.Warn -> p.warn
        Tone.Bad -> p.danger
        Tone.Muted -> p.faint
        Tone.Plain -> p.text2
    }
}

@Composable
private fun ToneGlyph(tone: Tone, label: String, size: Int = 14) {
    val icon = when (tone) {
        Tone.Ok -> OrchaIcons.Check
        Tone.Bad -> OrchaIcons.Close
        Tone.Warn -> OrchaIcons.WarningAmber
        else -> OrchaIcons.RemoveRedEye
    }
    Icon(icon, label, tint = toneColor(tone), modifier = Modifier.size(size.dp))
}

private fun openExternal(context: android.content.Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

/* ---------- goal ancestry ---------- */

/** "Objective → parent → …" above the title; parents open via [onOpenTask]. Nothing when there's no ancestry. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GoalChainBreadcrumb(chain: GoalChainDto?, onOpenTask: (String) -> Unit) {
    if (!TaskInsightsUx.hasAncestry(chain)) return
    val p = Orcha.palette
    val crumbs = TaskInsightsUx.goalCrumbs(chain)
    FlowRow(
        verticalArrangement = Arrangement.Center,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.semantics(mergeDescendants = false) { contentDescription = "Goal ancestry" },
    ) {
        crumbs.forEachIndexed { i, node ->
            if (i > 0) Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(12.dp).align(Alignment.CenterVertically))
            val label = TaskInsightsUx.goalCrumbLabel(node)
            if (node.kind == "parent" && node.id != null) {
                Text(
                    label,
                    style = ltype(LType.Meta), color = p.accent, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .clickable(role = Role.Button, onClickLabel = "Open parent task") { onOpenTask(node.id) }
                        .heightIn(min = 48.dp)
                        .padding(vertical = 14.dp)
                        .semantics { contentDescription = "Parent task: $label" },
                )
            } else {
                Text(
                    label,
                    style = ltype(LType.Meta), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.align(Alignment.CenterVertically).semantics { contentDescription = "Objective: $label" },
                )
            }
        }
    }
}

/* ---------- AI manager pre-review ---------- */

/** "Atlas (manager) recommends approval: …" + "Reviewer: maya · via Atlas’s manager". Advisory only. */
@Composable
internal fun ManagerReviewNote(task: TaskDto, reviewerName: String?) {
    val p = Orcha.palette
    val mr = TaskInsightsUx.managerReviewLine(task.managerReview)
    val via = TaskInsightsUx.reviewVia(task.reviewRouting)
    if (mr == null && via == null) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Review", style = ltype(LType.Micro), color = p.faint, modifier = Modifier.semantics { heading() })
        if (via != null) {
            val name = if (task.reviewRouting?.routedVia == "fallback") null else reviewerName ?: task.reviewRouting?.reviewerAlias
            Text("Reviewer: ${name ?: "anyone"} · $via", style = ltype(LType.Meta), color = p.text2)
        }
        if (mr != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), modifier = Modifier.semantics(mergeDescendants = true) {}) {
                Box(Modifier.padding(top = 2.dp)) { ToneGlyph(mr.second, "") }
                Column {
                    Text(mr.first, style = ltype(LType.Body), color = p.text)
                    (task.managerReview?.decidedAt ?: task.managerReview?.requestedAt)?.let(MobileUx::agoLabel)?.let {
                        Text(it, style = ltype(LType.Micro), color = p.faint)
                    }
                }
            }
        }
    }
}

/* ---------- evidence pack ---------- */

/** Compact "Proof" line in the verification card; "Details" expands the full pack in place. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun EvidenceProofBlock(
    insights: TaskInsightsState,
    baseUrl: String?,
    canRunVerdikt: Boolean,
    onRetry: () -> Unit,
    onRunVerdikt: () -> Unit,
) {
    val p = Orcha.palette
    val pack = insights.evidence
    var open by rememberSaveable(insights.taskId) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Proof", style = ltype(LType.Micro), color = p.faint, modifier = Modifier.semantics { heading() })
        when {
            pack == null && insights.evidenceError != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(insights.evidenceError, style = ltype(LType.Meta), color = p.faint, modifier = Modifier.weight(1f))
                LButton("Retry", onRetry, kind = LButtonKind.Ghost, size = LSize.Small)
            }
            pack == null -> Text(
                if (insights.evidenceLoading) "Gathering evidence…" else "No evidence yet.",
                style = ltype(LType.Meta), color = p.faint,
            )
            else -> {
                val parts = TaskInsightsUx.summaryParts(pack.summary, short = !open)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FlowRow(
                        Modifier.weight(1f).semantics(mergeDescendants = true) {
                            contentDescription = "Proof of work: " + parts.joinToString(", ") { it.text }
                        },
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (parts.isEmpty()) Text("Nothing recorded yet", style = ltype(LType.Meta), color = p.faint)
                        parts.forEachIndexed { i, part ->
                            if (i > 0) Text("·", style = ltype(LType.Meta), color = p.faint)
                            Text(part.text, style = ltype(LType.Meta), color = toneColor(part.tone))
                        }
                    }
                    Text(
                        if (open) "Hide" else "Details",
                        style = ltype(LType.Meta), color = p.accent,
                        modifier = Modifier
                            .clickable(role = Role.Button) { open = !open }
                            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
                            .heightIn(min = 48.dp)
                            .padding(start = LSpace.m, top = 14.dp, bottom = 14.dp),
                    )
                }
                if (open) {
                    EvidenceDetails(pack, insights.verdikt?.settings, baseUrl, canRunVerdikt, insights.busy, onRunVerdikt)
                }
            }
        }
    }
}

@Composable
private fun EvidenceHeading(text: String) {
    Text(text, style = ltype(LType.Meta), color = Orcha.palette.faint, modifier = Modifier.padding(top = LSpace.s).semantics { heading() })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EvidenceDetails(
    pack: EvidencePackDto,
    settings: VerdiktSettingsDto?,
    baseUrl: String?,
    canRunVerdikt: Boolean,
    busy: Boolean,
    onRunVerdikt: () -> Unit,
) {
    val p = Orcha.palette
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        LDivider()
        // Definition of done, line by line
        EvidenceHeading("Definition of done")
        if (pack.dod.items.isEmpty()) Text("No definition of done on this task.", style = ltype(LType.Meta), color = p.faint)
        pack.dod.items.forEach { item ->
            val tone = TaskInsightsUx.dodTone(item.status)
            val label = TaskInsightsUx.dodStatusLabel(item.status)
            Row(
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
                modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = label },
            ) {
                Box(Modifier.padding(top = 3.dp)) { ToneGlyph(tone, label) }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(inlineMarkdown(item.text), style = ltype(LType.Body), color = p.text)
                    Text(item.evidence ?: "$label — no machine evidence", style = ltype(LType.Meta), color = p.text2)
                    item.claim?.takeIf { it.isNotBlank() }?.let {
                        Text("Agent says: “$it”", style = ltype(LType.Meta), color = p.faint)
                    }
                }
            }
        }

        // Tests the runs actually ran
        EvidenceHeading("Tests")
        if (pack.tests.status == "none") {
            val n = pack.runs.size
            Text(
                if (n > 0) "No test command found in this task's $n run${if (n == 1) "" else "s"}." else "No test command found in any run (none recorded).",
                style = ltype(LType.Meta), color = p.faint,
            )
        }
        pack.tests.latest.forEach { inv ->
            val (text, tone) = TaskInsightsUx.invocationText(inv)
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), modifier = Modifier.semantics(mergeDescendants = true) {}) {
                Box(Modifier.padding(top = 3.dp)) { ToneGlyph(tone, "") }
                Column {
                    Text("${inv.framework} · $text", style = ltype(LType.Body), color = toneColor(tone).takeIf { tone != Tone.Plain } ?: p.text)
                    Text(inv.command, style = ltype(LType.Mono), color = p.faint, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (pack.tests.earlier > 0) {
            val e = pack.tests.earlier
            Text("$e earlier run${if (e == 1) "" else "s"} of the same command${if (e == 1) "" else "s"} superseded.", style = ltype(LType.Meta), color = p.faint)
        }

        // Changes: summary, branch, risk flags, PR links
        EvidenceHeading("Changes")
        pack.changes.summary.takeIf { it.isNotBlank() }?.let { Text(it, style = ltype(LType.Body), color = p.text) }
        pack.branch?.let {
            Text("Branch $it", style = ltype(LType.Meta).copy(fontFamily = FontFamily.Monospace), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (pack.flags.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                pack.flags.forEach { f ->
                    val tone = if (f.severity == "danger") Tone.Bad else Tone.Warn
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "${f.label}: ${f.detail}" },
                    ) {
                        ToneGlyph(tone, "", size = 12)
                        Text(f.label, style = ltype(LType.Meta), color = toneColor(tone))
                    }
                }
            }
            pack.flags.forEach { f ->
                if (f.files.isNotEmpty()) {
                    val more = (f.count - f.files.size).takeIf { it > 0 }?.let { " +$it more" } ?: ""
                    Text("${f.label}: ${f.files.joinToString(", ")}$more", style = ltype(LType.Micro), color = p.faint, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        // Only links a phone can open: PRs (the web's Live changes / Runs links are portal pages)
        pack.links.filter { it.href.startsWith("http") }.forEach { link ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier
                    .clickable(role = Role.Button) { openExternal(context, link.href) }
                    .heightIn(min = 48.dp),
            ) {
                Icon(OrchaIcons.OpenInNew, null, tint = p.accent, modifier = Modifier.size(14.dp))
                Text(link.label, style = ltype(LType.Meta), color = p.accent)
            }
        }

        VerdiktSection(pack.verdikt, settings, pack.taskId, baseUrl, canRunVerdikt, busy, onRunVerdikt)

        val n = pack.runs.size
        Text(
            buildString {
                append("Built ")
                append(MobileUx.agoLabel(pack.builtAt) ?: "just now")
                append(" from $n run${if (n == 1) "" else "s"}")
                if (pack.roundStartedAt != null) append(" since the last rejection")
            },
            style = ltype(LType.Micro), color = p.faint, modifier = Modifier.padding(top = LSpace.xs),
        )
    }
}

/* ---------- Verdikt ---------- */

@Composable
internal fun VerdiktSection(
    run: VerdiktRunDto?,
    settings: VerdiktSettingsDto?,
    taskId: String,
    baseUrl: String?,
    canRun: Boolean,
    busy: Boolean,
    onRun: () -> Unit,
) {
    val p = Orcha.palette
    val context = LocalContext.current
    val enabled = settings?.enabled == true && settings.configured
    // Nothing to say: never ran, and the project hasn't set Verdikt up (web shows a "Set up" link to settings — not on mobile).
    if (run == null && !enabled) {
        EvidenceHeading("Verdikt")
        Text("Verdikt isn't set up for this project.", style = ltype(LType.Meta), color = p.faint)
        return
    }
    EvidenceHeading("Verdikt")
    if (run == null) {
        Text("Not run for this task yet.", style = ltype(LType.Meta), color = p.faint)
    } else {
        val tone = if (run.status == "completed") TaskInsightsUx.verdiktTone(run.verdict) else Tone.Plain
        Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) {}) {
            if (run.status == "completed") ToneGlyph(tone, "")
            Text(TaskInsightsUx.verdiktHeadline(run), style = ltype(LType.BodyEmph), color = if (run.status == "completed") toneColor(tone) else p.text)
            Text(
                listOfNotNull(if (run.trigger == "auto") "auto" else "manual", MobileUx.agoLabel(run.finishedAt ?: run.createdAt)).joinToString(" · "),
                style = ltype(LType.Meta), color = p.faint,
            )
        }
        if (run.previousRound) {
            Text("From before the last rejection — it doesn't count for the rework. Run it again to check the new work.", style = ltype(LType.Meta), color = p.faint)
        }
        run.error?.takeIf { it.isNotBlank() }?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
        run.reason?.takeIf { it.isNotBlank() && run.status == "completed" }?.let { Text(it, style = ltype(LType.Meta), color = p.text2) }
        run.criteria.forEach { c ->
            val ct = TaskInsightsUx.verdiktTone(c.outcome)
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = c.outcome ?: "no verdict" }) {
                Box(Modifier.padding(top = 3.dp)) { ToneGlyph(ct, "") }
                Column {
                    Text(c.text, style = ltype(LType.Body), color = p.text)
                    if (c.outcome == "fail" || c.outcome == "warning") {
                        val detail = listOfNotNull(c.expected?.let { "Expected $it" }, c.actual?.let { "Actual $it" }).joinToString(" · ")
                        if (detail.isNotBlank()) Text(detail, style = ltype(LType.Meta), color = p.text2)
                    }
                }
            }
        }
        if (run.reportUrl != null && baseUrl != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier
                    .clickable(role = Role.Button) { openExternal(context, TaskInsightsUx.absoluteUrl(baseUrl, run.reportUrl)) }
                    .heightIn(min = 48.dp),
            ) {
                Icon(OrchaIcons.OpenInNew, null, tint = p.accent, modifier = Modifier.size(14.dp))
                Text("Open Verdikt report", style = ltype(LType.Meta), color = p.accent)
            }
        }
    }
    if (enabled && !TaskInsightsUx.verdiktOpen(run)) {
        val title = when {
            run == null -> "Run in Verdikt"
            run.status == "completed" -> "Run again"
            else -> "Retry"
        }
        LButton(title, onRun, icon = if (run == null) OrchaIcons.PlayArrow else OrchaIcons.Refresh, kind = LButtonKind.Secondary, size = LSize.Small, enabled = canRun && !busy)
    }
}
