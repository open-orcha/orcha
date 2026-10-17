package io.openorcha.mobile.ui.screens

/* Create / edit a routine (web pages/routines/RoutineDialog.tsx): task title, description,
   definition of done, assignee, priority, schedule presets or a custom cron validated live
   by the server preview (plain English + next runs), timezone, skip-if-open, enabled. */

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ProjectApi
import io.openorcha.mobile.data.RoutineDetailDto
import io.openorcha.mobile.data.SchedulePreviewResponse
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PriorityBand
import io.openorcha.mobile.domain.RoutineCopy
import io.openorcha.mobile.domain.RoutineSchedule
import io.openorcha.mobile.domain.ScheduleForm
import io.openorcha.mobile.domain.SchedulePreset
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.TimeZone

/** An AI agent the routine can be assigned to (id + alias). */
data class RoutineAssignee(val id: String, val alias: String)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RoutineEditorScreen(
    container: StoredContainer,
    /** null = create; else the routine id being edited (its fields load from the server). */
    routineId: String?,
    agents: List<RoutineAssignee>,
    onClose: () -> Unit,
    onSaved: (String) -> Unit,
) {
    val p = Orcha.palette
    val scope = rememberCoroutineScope()
    val deviceZone = remember { TimeZone.getDefault().id }
    var loaded by remember { mutableStateOf<RoutineDetailDto?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf<String?>(null) }
    var band by remember { mutableStateOf(PriorityBand.Normal) }
    var form by remember { mutableStateOf(ScheduleForm()) }
    var tz by remember { mutableStateOf(deviceZone) }
    var skipIfOpen by remember { mutableStateOf(true) }
    var enabled by remember { mutableStateOf(true) }
    var preview by remember { mutableStateOf<SchedulePreviewResponse?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onClose)

    LaunchedEffect(routineId) {
        val rid = routineId ?: return@LaunchedEffect
        runCatching { ProjectApi.routine(container.baseUrl, rid) }
            .onSuccess { r ->
                loaded = r
                title = r.title; description = r.description.orEmpty(); dod = r.definitionOfDone
                assignee = r.assigneeAgentId; band = MobileUx.priorityBand(r.priority)
                form = RoutineSchedule.fromCron(r.cron); tz = r.timezone
                skipIfOpen = r.skipIfOpen; enabled = r.enabled
            }
            .onFailure { loadError = routineErrorText(it) }
    }

    val cron = RoutineSchedule.toCron(form)
    // Server preview as the user edits (debounced); it's the authority on validity.
    LaunchedEffect(cron, tz) {
        delay(300)
        preview = if (!RoutineSchedule.looksLikeCron(cron)) {
            SchedulePreviewResponse(valid = false, error = "Use 5 fields: minute hour day-of-month month day-of-week.")
        } else {
            runCatching { ProjectApi.previewSchedule(container.baseUrl, container.id, cron, tz) }.getOrNull()
        }
    }

    val editing = routineId != null
    val ready = !editing || loaded != null
    val canSubmit = ready && !busy && title.isNotBlank() && dod.isNotBlank() && preview?.valid != false

    fun submit() {
        if (!canSubmit) return
        busy = true; error = null
        val body = buildJsonObject {
            put("title", title.trim())
            put("description", description.trim().ifBlank { null }?.let { JsonPrimitive(it) } ?: JsonNull)
            put("definition_of_done", dod.trim())
            put("assignee_agent_id", assignee?.let { JsonPrimitive(it) } ?: JsonNull)
            put("priority", MobileUx.priorityFor(band))
            put("cron", cron)
            put("timezone", tz)
            put("enabled", enabled)
            put("skip_if_open", skipIfOpen)
        }
        scope.launch {
            runCatching {
                if (routineId == null) ProjectApi.createRoutine(container.baseUrl, container.id, container.humanAgentId, body)
                else ProjectApi.updateRoutine(container.baseUrl, routineId, container.humanAgentId, body)
            }.onSuccess {
                onSaved(if (editing) "Routine saved." else "Routine created.")
            }.onFailure {
                error = "Couldn't save the routine — " + routineErrorText(it) + "."
            }
            busy = false
        }
    }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            LTopBar(title = if (editing) "Edit routine" else "New routine", onBack = onClose, backIsClose = true) {
                LButton(
                    if (busy) "Saving…" else if (editing) "Save routine" else "Create routine",
                    ::submit, kind = LButtonKind.Primary, size = LSize.Small, enabled = canSubmit,
                    modifier = Modifier.padding(end = LSpace.s),
                )
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.l),
        ) {
            loadError?.let { item { Text("Couldn't load the routine — $it.", style = ltype(LType.Body), color = p.danger) } }
            item {
                OrchaField(title, { title = it }, label = "Task title", placeholder = "Weekly dependency audit — {{date}}", maxLines = 2)
            }
            item {
                OrchaField(description, { description = it }, label = "Description", placeholder = "What should happen each time", minLines = 2)
            }
            item {
                OrchaField(dod, { dod = it }, label = "Definition of done", placeholder = "How a reviewer knows it's finished", minLines = 2)
            }
            item {
                LSection("Assignee") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                        LChip("Unassigned", selected = assignee == null, onClick = { assignee = null })
                        agents.forEach { a -> LChip(a.alias, selected = assignee == a.id, onClick = { assignee = a.id }) }
                        val gone = assignee?.takeIf { id -> agents.none { it.id == id } }
                        if (gone != null) LChip((loaded?.assigneeAlias ?: "unknown agent") + " (retired)", selected = true, onClick = {})
                    }
                    if (assignee == null) Text("Unassigned — normal assignment", style = ltype(LType.Meta), color = p.muted)
                }
            }
            item { CreateTaskPrioritySelector(band) { band = it } }
            item {
                LSection("Schedule") {
                    LSegmented(
                        options = SchedulePreset.entries.map { it to it.label },
                        selection = form.preset,
                        onSelect = { pr -> form = form.copy(preset = pr, cron = if (pr == SchedulePreset.Custom) RoutineSchedule.toCron(form) else form.cron) },
                    )
                    Column(Modifier.padding(top = LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                        when (form.preset) {
                            SchedulePreset.Hourly -> ChipLine("At minute", (0..55 step 5).map { it to ":%02d".format(it) }, form.minute) { form = form.copy(minute = it) }
                            SchedulePreset.Weekly -> ChipLine("On", listOf(1, 2, 3, 4, 5, 6, 0).map { it to RoutineSchedule.DAY_NAMES[it].take(3) }, form.weekday) { form = form.copy(weekday = it) }
                            SchedulePreset.Monthly -> ChipLine("On day", (1..28).map { it to it.toString() }, form.monthDay) { form = form.copy(monthDay = it) }
                            else -> Unit
                        }
                        if (form.preset != SchedulePreset.Hourly && form.preset != SchedulePreset.Custom) {
                            OrchaField(form.time, { form = form.copy(time = it) }, label = "At (24-hour, HH:MM)", placeholder = "09:00", maxLines = 1)
                        }
                        if (form.preset == SchedulePreset.Custom) {
                            OrchaField(
                                form.cron, { form = form.copy(cron = it) }, label = "Cron", placeholder = "minute hour day month weekday", maxLines = 1,
                                supporting = "5 fields on the local clock: minute hour day-of-month month day-of-week. At most one run every 15 minutes.",
                            )
                        }
                        val zones = remember(deviceZone, tz) { (listOf(deviceZone, tz) + RoutineSchedule.ZONES).distinct() }
                        ChipLine("Timezone", zones.map { it to it.replace('_', ' ') }, tz) { tz = it }
                        val pv = preview
                        Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                            when {
                                pv == null -> Text("Checking schedule…", style = ltype(LType.Meta), color = p.muted)
                                !pv.valid -> Text(pv.error ?: "That schedule isn't valid.", style = ltype(LType.Meta), color = p.danger)
                                else -> {
                                    Text(pv.scheduleText ?: "", style = ltype(LType.BodyEmph), color = p.text)
                                    if (pv.nextRuns.isNotEmpty()) {
                                        Text(
                                            "Next: " + pv.nextRuns.mapNotNull { RoutineCopy.formatInZone(it, tz) }.joinToString(" · "),
                                            style = ltype(LType.Meta), color = p.text2,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            item { ProjectCheckRow("Skip a run while the previous task is still open", skipIfOpen) { skipIfOpen = it } }
            item { ProjectCheckRow("Enabled", enabled) { enabled = it } }
            item {
                Text(
                    "Each run creates a normal task as you — plan approval, verification and autonomy rules apply as usual.",
                    style = ltype(LType.Meta), color = p.muted,
                )
            }
            error?.let { item { Text(it, style = ltype(LType.Body), color = p.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) } }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> ChipLine(label: String, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = ltype(LType.Meta), color = Orcha.palette.muted)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEach { (v, t) -> LChip(t, selected = v == selected, onClick = { onSelect(v) }) }
        }
    }
}

@Composable
internal fun ProjectCheckRow(label: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Checkbox(
            checked = checked, onCheckedChange = null, enabled = enabled,
            colors = CheckboxDefaults.colors(checkedColor = p.lPrimaryFill, uncheckedColor = p.border2),
        )
        Text(label, style = ltype(LType.Body), color = if (enabled) p.text else p.muted)
    }
}
