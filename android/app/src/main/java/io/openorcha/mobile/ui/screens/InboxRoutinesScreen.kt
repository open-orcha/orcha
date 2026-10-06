package io.openorcha.mobile.ui.screens

/* Routines (web pages/routines/RoutinesPage.tsx): recurring work with its schedule in
   words, next and last run; pause/resume, Run now, delete (with confirm) and the recent
   runs of the one you open. Create and edit open the routine editor (RoutineEditorScreen). */

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.ktor.client.plugins.ResponseException
import io.ktor.client.statement.bodyAsText
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.InboxRoutineDto
import io.openorcha.mobile.data.InboxRoutineRunDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RoutineCopy
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The server's own `detail` sentence when it sent one, else a plain fallback (never a status code). */
internal suspend fun routineErrorText(err: Throwable): String {
    val resp = (err as? ResponseException)?.response ?: return "Embodent couldn't be reached"
    val detail = runCatching {
        ((Json.parseToJsonElement(resp.bodyAsText()) as? JsonObject)?.get("detail") as? JsonPrimitive)?.contentOrNull
    }.getOrNull()
    return detail?.takeIf { it.isNotBlank() && !it.startsWith("{") }
        ?: when (resp.status.value) {
            401, 403 -> "you don't have permission to manage routines"
            404 -> "it no longer exists"
            else -> "Embodent hit an error — try again"
        }
}

private sealed class RoutineConfirm {
    data class Run(val routine: InboxRoutineDto) : RoutineConfirm()
    data class Delete(val routine: InboxRoutineDto) : RoutineConfirm()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxRoutinesScreen(
    container: StoredContainer,
    onBack: () -> Unit,
    onOpenTask: ((String) -> Unit)? = null,
    /** AI agents a routine can be assigned to (the editor's assignee chips). */
    agents: List<RoutineAssignee> = emptyList(),
) {
    val p = Orcha.palette
    val scope = rememberCoroutineScope()
    val base = container.baseUrl
    val actor = container.humanAgentId
    var routines by remember { mutableStateOf<List<InboxRoutineDto>?>(null) }
    var lastTick by remember { mutableStateOf<String?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }
    var expanded by remember { mutableStateOf<String?>(null) }
    val runs = remember { mutableStateMapOf<String, List<InboxRoutineRunDto>>() }
    val toggling = remember { mutableStateMapOf<String, Boolean>() }
    var confirm by remember { mutableStateOf<RoutineConfirm?>(null) }
    var actBusy by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    // Editor: null = closed, "" = new routine, else the routine id being edited.
    var editor by remember { mutableStateOf<String?>(null) }
    var savedNote by remember { mutableStateOf<String?>(null) }
    BackHandler(enabled = editor == null, onBack = onBack)

    suspend fun reload() {
        runCatching { InboxApi.routines(base, container.id) }
            .onSuccess { routines = it.routines; lastTick = it.scheduler.lastTickAt; loadError = null }
            .onFailure { loadError = routineErrorText(it) }
    }

    suspend fun loadRuns(rid: String) {
        runCatching { InboxApi.routineRuns(base, rid) }.onSuccess { runs[rid] = it.runs }
    }

    LaunchedEffect(container.id, reloadKey) { reload() }
    LaunchedEffect(savedNote) { savedNote?.let { snackbar.showSnackbar(it); savedNote = null } }

    editor?.let { target ->
        RoutineEditorScreen(
            container = container,
            routineId = target.ifEmpty { null },
            agents = agents,
            onClose = { editor = null },
            onSaved = { note -> editor = null; savedNote = note; reloadKey++ },
        )
        return
    }

    fun toggle(r: InboxRoutineDto, on: Boolean) {
        toggling[r.id] = true
        routines = routines?.map { if (it.id == r.id) it.copy(enabled = on) else it }
        scope.launch {
            runCatching { InboxApi.setRoutineEnabled(base, r.id, actor, on) }
                .onSuccess { saved -> routines = routines?.map { if (it.id == r.id) saved else it } }
                .onFailure {
                    routines = routines?.map { if (it.id == r.id) it.copy(enabled = r.enabled) else it }
                    snackbar.showSnackbar("Couldn't " + (if (on) "enable" else "pause") + " the routine — " + routineErrorText(it))
                }
            toggling.remove(r.id)
        }
    }

    Scaffold(
        containerColor = p.bg,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg, titleContentColor = p.text),
                    title = { Text("Routines", style = ltype(LType.Headline)) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back", tint = p.text2) } },
                    actions = {
                        IconButton(onClick = { reloadKey++ }) { Icon(OrchaIcons.Refresh, "Refresh", tint = p.text2) }
                        if (actor != null) {
                            LButton(
                                "New routine", { editor = "" }, icon = OrchaIcons.Add,
                                kind = LButtonKind.Primary, size = LSize.Small, modifier = Modifier.padding(end = LSpace.s),
                            )
                        }
                    },
                )
                LDivider()
            }
        },
    ) { padding ->
        val list = routines
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            when {
                list == null && loadError != null -> item {
                    LEmptyState(
                        icon = OrchaIcons.WarningAmber, title = "Couldn't load routines",
                        message = loadError!!.replaceFirstChar { it.uppercase() } + ".",
                        actionTitle = "Retry", onAction = { reloadKey++ },
                    )
                }
                list == null -> item { Text("Loading routines…", style = ltype(LType.Meta), color = p.muted) }
                list.isEmpty() -> item {
                    LEmptyState(
                        icon = OrchaIcons.Schedule, title = "No routines yet",
                        message = "Routines create a task on a schedule. Create one here, or use “Make recurring…” on any task.",
                        actionTitle = if (actor != null) "New routine" else null,
                        onAction = if (actor != null) ({ editor = "" }) else null,
                    )
                }
                else -> {
                    item(key = "scheduler") {
                        Text(
                            lastTick?.let { "Scheduler checked ${MobileUx.agoLabel(it) ?: "recently"}." }
                                ?: "The scheduler hasn't checked in yet — routines fire while the Embodent notifier is running (orcha up starts it).",
                            style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(horizontal = 4.dp),
                        )
                    }
                    items(list, key = { it.id }) { r ->
                        RoutineCard(
                            r = r,
                            open = expanded == r.id,
                            runs = runs[r.id],
                            toggling = toggling[r.id] == true,
                            canAct = actor != null,
                            onToggleOpen = {
                                expanded = if (expanded == r.id) null else r.id
                                if (expanded == r.id) scope.launch { loadRuns(r.id) }
                            },
                            onEnabled = { toggle(r, it) },
                            onRun = { confirm = RoutineConfirm.Run(r) },
                            onDelete = { confirm = RoutineConfirm.Delete(r) },
                            onEdit = { editor = r.id },
                            onOpenTask = onOpenTask,
                        )
                    }
                }
            }
            loadError?.takeIf { list != null }?.let { item { Banner(BannerKind.Danger, "Couldn't refresh — $it.") } }
        }
    }

    when (val c = confirm) {
        is RoutineConfirm.Run -> AlertDialog(
            onDismissRequest = { if (!actBusy) confirm = null },
            title = { Text("Run “${c.routine.displayTitle}” now?") },
            text = {
                Text(
                    if (c.routine.skipIfOpen) "Creates the task now. If the last one is still open, this run is skipped."
                    else "Creates the task now, even if the last one is still open.",
                )
            },
            confirmButton = {
                TextButton(enabled = !actBusy, onClick = {
                    actBusy = true
                    scope.launch {
                        runCatching { InboxApi.runRoutineNow(base, c.routine.id, actor) }
                            .onSuccess { res ->
                                snackbar.showSnackbar(
                                    when (res.outcome) {
                                        "skipped" -> "Skipped" + (res.detailText?.let { " — $it" } ?: ".")
                                        "failed" -> "Couldn't run the routine" + (res.detailText?.let { " — $it" } ?: ".")
                                        else -> res.detailText?.let { "Task created — $it" } ?: "Task created."
                                    },
                                )
                                reload()
                                if (expanded == c.routine.id) loadRuns(c.routine.id)
                            }
                            .onFailure { snackbar.showSnackbar("Couldn't run the routine — " + routineErrorText(it)) }
                        actBusy = false
                        confirm = null
                    }
                }) { Text("Create task", color = p.accent, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }, enabled = !actBusy) { Text("Cancel", color = p.muted) } },
            containerColor = p.raised,
        )
        is RoutineConfirm.Delete -> AlertDialog(
            onDismissRequest = { if (!actBusy) confirm = null },
            title = { Text("Delete “${c.routine.displayTitle}”?") },
            text = { Text("It stops creating tasks. Its run history and the tasks it already created are kept.") },
            confirmButton = {
                TextButton(enabled = !actBusy, onClick = {
                    actBusy = true
                    scope.launch {
                        runCatching { InboxApi.deleteRoutine(base, c.routine.id, actor) }
                            .onSuccess {
                                routines = routines?.filterNot { it.id == c.routine.id }
                                snackbar.showSnackbar("Routine deleted. Its history and tasks are kept.")
                            }
                            .onFailure { snackbar.showSnackbar("Couldn't delete the routine — " + routineErrorText(it)) }
                        actBusy = false
                        confirm = null
                    }
                }) { Text("Delete routine", color = p.danger, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }, enabled = !actBusy) { Text("Cancel", color = p.muted) } },
            containerColor = p.raised,
        )
        null -> Unit
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RoutineCard(
    r: InboxRoutineDto,
    open: Boolean,
    runs: List<InboxRoutineRunDto>?,
    toggling: Boolean,
    canAct: Boolean,
    onToggleOpen: () -> Unit,
    onEnabled: (Boolean) -> Unit,
    onRun: () -> Unit,
    onDelete: () -> Unit,
    onEdit: () -> Unit,
    onOpenTask: ((String) -> Unit)?,
) {
    val p = Orcha.palette
    LCard {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(role = Role.Button, onClickLabel = if (open) "Hide details" else "Show details", onClick = onToggleOpen),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(r.displayTitle, style = ltype(LType.BodyEmph), color = if (r.enabled) p.text else p.muted)
                Text(r.scheduleText.ifBlank { r.cron }, style = ltype(LType.Meta), color = p.text2)
                Text(
                    RoutineCopy.nextRun(r.enabled, r.nextRunAt) + " · Last: " + RoutineCopy.lastResult(r.lastRun),
                    style = ltype(LType.Meta), color = p.muted,
                )
            }
            SwitchRowCompact(
                checked = r.enabled,
                enabled = canAct && !toggling,
                label = (if (r.enabled) "Pause " else "Enable ") + r.displayTitle,
                onChange = onEnabled,
            )
        }
        if (open) {
            LDivider(Modifier.padding(vertical = LSpace.s))
            Detail("Next run", if (!r.enabled) "Paused" else RoutineCopy.formatInZone(r.nextRunAt, r.timezone)?.let { "$it (${RoutineCopy.relFuture(r.nextRunAt)})" } ?: "No upcoming run")
            Detail("Timezone", r.timezone.replace('_', ' '))
            Detail("Assignee", r.assigneeAlias?.let { it + if (r.assigneeRetired) " (retired — tasks left unassigned)" else "" } ?: "Unassigned — normal assignment")
            Detail("If still open", if (r.skipIfOpen) "Skip the run" else "Create another task")
            if (r.definitionOfDone.isNotBlank()) Detail("Done when", r.definitionOfDone)
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(LSpace.s),
                verticalArrangement = Arrangement.spacedBy(LSpace.s),
                modifier = Modifier.padding(vertical = LSpace.s),
            ) {
                LButton("Edit", onEdit, kind = LButtonKind.Secondary, size = LSize.Small, enabled = canAct)
                LButton("Run now", onRun, icon = OrchaIcons.PlayArrow, kind = LButtonKind.Secondary, size = LSize.Small, enabled = canAct)
                LButton("Delete routine", onDelete, kind = LButtonKind.Danger, size = LSize.Small, enabled = canAct)
            }
            LSection("History") {
                when {
                    runs == null -> Text("Loading history…", style = ltype(LType.Meta), color = p.muted)
                    runs.isEmpty() -> Text("No runs yet.", style = ltype(LType.Meta), color = p.muted)
                    else -> runs.take(8).forEach { run ->
                        val taskId = run.taskId
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 44.dp)
                                .then(
                                    if (taskId != null && onOpenTask != null && run.outcome == "created") {
                                        Modifier.clickable(role = Role.Button, onClickLabel = "Open task") { onOpenTask(taskId) }
                                    } else Modifier,
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(LSpace.s),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    run.taskTitle ?: RoutineCopy.trigger(run),
                                    style = ltype(LType.Body), color = p.text, maxLines = 1,
                                )
                                Text(
                                    listOfNotNull(RoutineCopy.trigger(run), MobileUx.agoLabel(run.createdAt), run.detailText).joinToString(" · "),
                                    style = ltype(LType.Micro), color = p.muted, maxLines = 2,
                                )
                            }
                            LTag(
                                RoutineCopy.lastResult(run),
                                tint = when (run.outcome) { "failed" -> p.danger; "created" -> p.ok; else -> null },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Detail(label: String, value: String) {
    val p = Orcha.palette
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
        Text(label, style = ltype(LType.Meta), color = p.muted, modifier = Modifier.weight(0.4f))
        Text(value, style = ltype(LType.Meta), color = p.text2, modifier = Modifier.weight(0.6f))
    }
}

@Composable
private fun SwitchRowCompact(checked: Boolean, enabled: Boolean, label: String, onChange: (Boolean) -> Unit) {
    val p = Orcha.palette
    Switch(
        checked = checked,
        onCheckedChange = onChange,
        enabled = enabled,
        modifier = Modifier.semantics { contentDescription = label },
        colors = SwitchDefaults.colors(
            checkedTrackColor = p.lPrimaryFill, checkedThumbColor = p.lPrimaryText,
            uncheckedTrackColor = p.surface2, uncheckedBorderColor = p.border2, uncheckedThumbColor = p.faint,
        ),
    )
}
