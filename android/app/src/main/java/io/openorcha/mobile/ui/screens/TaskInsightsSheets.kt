package io.openorcha.mobile.ui.screens

/**
 * Task ⋯ menu / Properties sheets for the parity features: Reassign…, the reviewer picker
 * (iOS `ReviewerPickerSheet` parity) and "Make recurring…" (web `MakeRecurringDialog`).
 */

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.RoutineCreateBody
import io.openorcha.mobile.data.SchedulePreviewDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.TaskInsightsUx
import io.openorcha.mobile.domain.TaskInsightsUx.Preset
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.delay
import java.util.TimeZone

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InsightSheet(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val p = Orcha.palette
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = LSpace.l).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            Text(title, style = ltype(LType.Title), color = p.text, modifier = Modifier.semantics { heading() })
            content()
        }
    }
}

/** One radio row: avatar/glyph, title + subtitle, a check when picked. 48dp+ target. */
@Composable
private fun PickRow(title: String, sub: String?, selected: Boolean, onClick: () -> Unit, leading: @Composable () -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = LSpace.m, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(title, style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            sub?.takeIf { it.isNotBlank() }?.let { Text(it, style = ltype(LType.Meta), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (selected) Icon(OrchaIcons.Check, null, tint = p.accent, modifier = Modifier.size(18.dp))
    }
}

/* ---------- Reassign… ---------- */

/** Live AI agents only — the server refuses humans and retired agents (409). */
internal fun reassignCandidates(agents: List<AgentDto>): List<AgentDto> =
    agents.filter { it.kind == "ai" && it.terminatedAt == null }.sortedBy { it.alias.lowercase() }

@Composable
internal fun ReassignSheet(
    task: TaskDto,
    agents: List<AgentDto>,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onPick: (AgentDto) -> Unit,
) {
    val p = Orcha.palette
    val current = task.assignees.firstOrNull() ?: task.ownerAlias
    val candidates = reassignCandidates(agents)
    var picked by remember(task.id) { mutableStateOf(candidates.firstOrNull { it.alias == current }?.id) }
    InsightSheet("Reassign", onDismiss) {
        Text(
            "Who should work on “${task.title}”? The current assignee is released and the new agent is woken.",
            style = ltype(LType.Meta), color = p.text2,
        )
        if (candidates.isEmpty()) {
            Text("No AI agents in this project yet.", style = ltype(LType.Body), color = p.faint)
        } else {
            LSection("Agents", count = candidates.size) {
                LCard(padding = 0.dp) {
                    candidates.forEachIndexed { i, a ->
                        if (i > 0) LDivider()
                        PickRow(
                            title = a.alias,
                            sub = listOfNotNull(a.role, if (a.alias == current) "Current assignee" else null).joinToString(" · "),
                            selected = picked == a.id,
                            onClick = { picked = a.id },
                        ) { LAvatar(a.alias, isAI = true, size = 28.dp) }
                    }
                }
            }
        }
        error?.let { Banner(BannerKind.Danger, it) }
        val target = candidates.firstOrNull { it.id == picked }
        LButton(
            target?.let { "Reassign to ${it.alias}" } ?: "Reassign",
            { target?.let(onPick) },
            kind = LButtonKind.Primary,
            enabled = !busy && target != null && target.alias != current,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/* ---------- Reviewer picker ---------- */

internal fun reviewerCandidates(agents: List<AgentDto>): List<AgentDto> =
    agents.filter { it.kind == "human" && it.terminatedAt == null }

@Composable
internal fun ReviewerPickerSheet(
    task: TaskDto,
    agents: List<AgentDto>,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (String?) -> Unit,
) {
    val p = Orcha.palette
    val humans = reviewerCandidates(agents)
    var picked by remember(task.id) { mutableStateOf(task.reviewerAgentId) }
    InsightSheet("Reviewer", onDismiss) {
        Text(
            "Who should verify “${task.title}”? Anyone can still verify; this only routes the review.",
            style = ltype(LType.Meta), color = p.text2,
        )
        LCard(padding = 0.dp) {
            PickRow("Anyone", "No assigned reviewer", picked == null, { picked = null }) {
                Box(Modifier.size(28.dp).background(p.surface2, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(OrchaIcons.Public, null, tint = p.faint, modifier = Modifier.size(16.dp))
                }
            }
        }
        LSection("Members", count = humans.size) {
            LCard(padding = 0.dp) {
                humans.forEachIndexed { i, h ->
                    if (i > 0) LDivider()
                    val name = h.githubLogin ?: h.alias
                    PickRow(name, roleLabel(h.memberRole), picked == h.id, { picked = h.id }) { LAvatar(name, isAI = false, size = 28.dp) }
                }
            }
        }
        error?.let { Banner(BannerKind.Danger, it) }
        LButton(
            if (picked == null) "Clear reviewer" else "Assign reviewer",
            { onConfirm(picked) },
            kind = LButtonKind.Primary,
            enabled = !busy && picked != task.reviewerAgentId,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun roleLabel(role: String?): String = when (role) {
    "owner" -> "Owner"
    "member" -> "Member"
    "viewer" -> "Viewer"
    else -> ""
}

/* ---------- Make recurring… ---------- */

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MakeRecurringSheet(
    task: TaskDto,
    agents: List<AgentDto>,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onPreview: suspend (cron: String, timezone: String) -> SchedulePreviewDto?,
    onCreate: (buildBody: (String) -> RoutineCreateBody) -> Unit,
) {
    val p = Orcha.palette
    val tz = remember { TimeZone.getDefault().id }
    // Routines assign each run to an AI agent — only carry an AI assignee over (web routinePrefillFromTask).
    val aiAssignee = remember(task.id) {
        val alias = task.assignees.firstOrNull() ?: task.ownerAlias
        agents.firstOrNull { it.alias == alias && it.kind == "ai" && it.terminatedAt == null }
    }
    var title by remember(task.id) { mutableStateOf(task.title) }
    var dod by remember(task.id) { mutableStateOf(task.definitionOfDone.orEmpty()) }
    var preset by remember { mutableStateOf(Preset.Weekdays) }
    var time by remember { mutableStateOf("09:00") }
    var minute by remember { mutableStateOf("0") }
    var weekday by remember { mutableStateOf(1) }
    var monthDay by remember { mutableStateOf("1") }
    var skipIfOpen by remember { mutableStateOf(true) }
    var preview by remember { mutableStateOf<SchedulePreviewDto?>(null) }

    val (hour, min) = parseTime(time)
    val cron = TaskInsightsUx.toCron(
        preset,
        hour = hour,
        minute = if (preset == Preset.Hourly) minute.toIntOrNull() ?: 0 else min,
        weekday = weekday,
        monthDay = monthDay.toIntOrNull() ?: 1,
    )
    LaunchedEffect(cron, tz) {
        delay(300) // debounce typing in the time fields
        preview = onPreview(cron, tz)
    }

    InsightSheet("Make recurring", onDismiss) {
        Text("A routine creates a copy of this task on a schedule. The task itself is unchanged.", style = ltype(LType.Meta), color = p.text2)
        OrchaField(title, { title = it }, label = "Title", maxLines = 2)
        OrchaField(dod, { dod = it }, label = "Definition of done", minLines = 2, maxLines = 6, isError = dod.isBlank())
        Text(
            aiAssignee?.let { "Each run is assigned to ${it.alias}." } ?: "Runs use the project's normal assignment.",
            style = ltype(LType.Meta), color = p.faint,
        )

        Text("Repeat", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.semantics { heading() })
        LSegmented(options = Preset.entries.map { it to it.label }, selection = preset, onSelect = { preset = it })
        when (preset) {
            Preset.Hourly -> OrchaField(minute, { minute = it.filter(Char::isDigit).take(2) }, label = "Minute past the hour", maxLines = 1)
            else -> OrchaField(time, { time = it.take(5) }, label = "Time (HH:MM)", maxLines = 1, isError = !TIME_RE.matches(time.trim()))
        }
        if (preset == Preset.Weekly) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                TaskInsightsUx.DAY_NAMES.forEachIndexed { i, d ->
                    LChip(d.take(3), selected = weekday == i, onClick = { weekday = i })
                }
            }
        }
        if (preset == Preset.Monthly) {
            OrchaField(monthDay, { monthDay = it.filter(Char::isDigit).take(2) }, label = "Day of the month (1–28)", maxLines = 1)
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val pv = preview
            when {
                pv != null && !pv.valid -> Text(pv.error ?: "That schedule isn't valid.", style = ltype(LType.Meta), color = p.danger)
                else -> {
                    Text(pv?.scheduleText ?: preset.label, style = ltype(LType.BodyEmph), color = p.text)
                    if (pv != null && pv.nextRuns.isNotEmpty()) {
                        Text("Next: " + pv.nextRuns.joinToString(" · ") { TaskInsightsUx.formatRun(it, tz) }, style = ltype(LType.Meta), color = p.text2)
                    }
                }
            }
            Text("Time zone: ${tz.replace('_', ' ')}", style = ltype(LType.Micro), color = p.faint)
        }
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Switch) { skipIfOpen = !skipIfOpen }.heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Skip a run while the previous task is still open", style = ltype(LType.Body), color = p.text, modifier = Modifier.weight(1f))
            Switch(
                checked = skipIfOpen, onCheckedChange = null,
                colors = SwitchDefaults.colors(
                    checkedTrackColor = p.lPrimaryFill, checkedThumbColor = p.lPrimaryText,
                    uncheckedTrackColor = p.surface2, uncheckedBorderColor = p.border2, uncheckedThumbColor = p.faint,
                ),
            )
        }
        Text("Each run creates a normal task as you — plan approval, verification and autonomy rules apply as usual.", style = ltype(LType.Micro), color = p.faint)
        error?.let { Banner(BannerKind.Danger, it) }
        val valid = title.isNotBlank() && dod.isNotBlank() && (preset == Preset.Hourly || TIME_RE.matches(time.trim())) && preview?.valid != false
        LButton(
            "Create routine",
            {
                onCreate { actor ->
                    RoutineCreateBody(
                        actorAgentId = actor,
                        title = title.trim(),
                        description = task.description?.takeIf { it.isNotBlank() },
                        definitionOfDone = dod.trim(),
                        assigneeAgentId = aiAssignee?.id,
                        priority = task.priority?.takeIf { it >= 0 } ?: 100,
                        cron = cron,
                        timezone = tz,
                        enabled = true,
                        skipIfOpen = skipIfOpen,
                        originTaskId = task.id,
                    )
                }
            },
            kind = LButtonKind.Primary,
            enabled = valid && !busy,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private val TIME_RE = Regex("^\\d{1,2}:\\d{2}$")

internal fun parseTime(raw: String): Pair<Int, Int> {
    val m = TIME_RE.find(raw.trim()) ?: return 9 to 0
    val (h, mi) = m.value.split(":").map { it.toInt() }
    return h.coerceIn(0, 23) to mi.coerceIn(0, 59)
}
