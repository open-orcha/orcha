package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PriorityBand
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import io.openorcha.mobile.ui.components.lSelected
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 11 — Create & assign a task. Field order fixed: Title → Description →
   DoD → Assign to → Priority → Advanced (Depends on + Park it). Create disabled
   until Title + DoD are non-blank; dirty form asks before discarding.
   ============================================================================= */

@Composable
fun CreateTaskScreen(
    state: OrchaUiState,
    onBack: () -> Unit,
    onCreate: (String, String?, String, String?, Int, List<String>, Boolean) -> Unit,
) {
    val p = Orcha.palette
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var dod by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf<String?>(null) }
    var band by remember { mutableStateOf(PriorityBand.Normal) }
    var advanced by remember { mutableStateOf(false) }
    var dependsOn by remember { mutableStateOf(setOf<String>()) }
    var parked by remember { mutableStateOf(false) }
    var confirmDiscard by remember { mutableStateOf(false) }
    var triedSubmit by remember { mutableStateOf(false) }
    // Set synchronously in onClick so a rapid second tap is a no-op immediately —
    // state.actionInFlight only flips on the next dispatch, leaving a window for a
    // duplicate createTask POST (GH #124). Reset when the action settles so the
    // failure/retry path stays usable (success navigates away).
    var submitting by remember { mutableStateOf(false) }
    LaunchedEffect(state.actionInFlight) { if (!state.actionInFlight) submitting = false }

    val dirty = title.isNotBlank() || description.isNotBlank() || dod.isNotBlank() || assignee != null || parked || dependsOn.isNotEmpty()
    val valid = title.isNotBlank() && dod.isNotBlank()
    val agents = state.snapshot?.agents.orEmpty().filter { it.kind == "ai" && it.terminatedAt == null }
    val openTasks = state.snapshot?.tasks.orEmpty().filterNot { it.status in setOf("completed", "cancelled") }
    fun requestClose() { if (dirty) confirmDiscard = true else onBack() }

    val submit: () -> Unit = submit@{
        if (submitting || state.actionInFlight) return@submit
        triedSubmit = true
        if (valid) {
            submitting = true
            onCreate(
                title.trim(),
                description.trim().ifBlank { null },
                dod.trim(),
                assignee,
                MobileUx.priorityFor(band),
                dependsOn.toList(),
                parked,
            )
        }
    }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            LTopBar(title = "New task", onBack = { requestClose() }, backIsClose = true) {
                LButton(
                    "Create", submit,
                    kind = LButtonKind.Primary, size = LSize.Small,
                    enabled = valid && !submitting && !state.actionInFlight,
                    modifier = Modifier.padding(end = LSpace.s),
                )
            }
        },
    ) { padding ->
        LazyColumn(
            // issue 2 regression guard: with adjustResize the window no longer pans, so
            // the form itself must give way to the keyboard
            modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
            contentPadding = PaddingValues(LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.l),
        ) {
            item {
                OrchaField(
                    title, { title = it }, label = "Title",
                    isError = triedSubmit && title.isBlank(),
                    supporting = if (triedSubmit && title.isBlank()) "A title is required." else null,
                    maxLines = 2,
                )
            }
            item {
                OrchaField(
                    description, { description = it }, label = "Description", minLines = 3,
                    supporting = "Context the agent will read.",
                )
            }
            item {
                OrchaField(
                    dod, { dod = it }, label = "Definition of done", minLines = 3,
                    isError = triedSubmit && dod.isBlank(),
                    supporting = if (triedSubmit && dod.isBlank()) "Required — the agent stops at needs-verification and you check against this."
                    else "How will you know it's done? The agent stops at needs-verification and you check against this.",
                )
            }
            item {
                LSection("Assign to", trailing = {
                    Text(assignee ?: "Unassigned", style = ltype(LType.Meta), color = p.faint)
                }) {
                    if (agents.isEmpty()) {
                        Text("No agents registered yet — the task will start unassigned.", style = ltype(LType.Meta), color = p.muted)
                    } else {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                            item { CreateAssigneeChip("Unassigned", assignee == null) { assignee = null } }
                            items(agents, key = { it.id }) { a ->
                                CreateAssigneeChip(a.alias, assignee == a.alias, avatar = true, status = a.status, model = a.model) { assignee = a.alias }
                            }
                        }
                        agents.firstOrNull { it.alias == assignee && it.status == "working" }?.let {
                            Text("${it.alias} is working — will pick this up next.", style = ltype(LType.Micro), color = p.faint)
                        }
                    }
                }
            }
            item { CreateTaskPrioritySelector(band) { band = it } }
            item {
                Row(
                    Modifier.fillMaxWidth().clickable { advanced = !advanced }.heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LSpace.s),
                ) {
                    Icon(
                        if (advanced) OrchaIcons.ExpandMore else OrchaIcons.ChevronRight, null,
                        tint = p.faint, modifier = Modifier.size(16.dp),
                    )
                    Text("Advanced", style = ltype(LType.Meta), color = p.text2, modifier = Modifier.semantics { heading() })
                    Text(if (advanced) "Depends on, park it" else "", style = ltype(LType.Meta), color = p.faint)
                }
            }
            if (advanced) {
                item {
                    LSection("Depends on", count = dependsOn.size.takeIf { it > 0 }) {
                        Text("This task won't become ready until these complete.", style = ltype(LType.Meta), color = p.faint)
                        LCard(padding = 0.dp) {
                            openTasks.take(12).forEachIndexed { i, t ->
                                if (i > 0) LDivider()
                                val on = t.id in dependsOn
                                Row(
                                    Modifier.fillMaxWidth().clickable {
                                        dependsOn = if (on) dependsOn - t.id else dependsOn + t.id
                                    }.heightIn(min = 48.dp).padding(horizontal = LSpace.m),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Checkbox(
                                        checked = on, onCheckedChange = null,
                                        colors = CheckboxDefaults.colors(checkedColor = p.lPrimaryFill, uncheckedColor = p.border2, checkmarkColor = p.lPrimaryText),
                                    )
                                    LStatusGlyph(t.status, size = 14.dp)
                                    Text(t.title, style = ltype(LType.Body), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    Text(t.shortId, style = ltype(LType.Mono), color = p.faint)
                                }
                            }
                        }
                    }
                }
                item {
                    LCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text("Park it", style = ltype(LType.BodyEmph), color = p.text)
                                Text("The agent won't start yet — the task is created pending.", style = ltype(LType.Meta), color = p.faint)
                            }
                            Switch(
                                checked = parked, onCheckedChange = { parked = it },
                                colors = SwitchDefaults.colors(
                                    checkedTrackColor = p.lPrimaryFill, checkedThumbColor = p.lPrimaryText,
                                    uncheckedTrackColor = p.surface2, uncheckedBorderColor = p.border2, uncheckedThumbColor = p.faint,
                                ),
                            )
                        }
                    }
                }
            }
            state.error?.let { item { Banner(BannerKind.Danger, "Couldn't create the task — nothing was lost. $it") } }
            item { Spacer(Modifier.padding(bottom = 24.dp)) }
        }
    }

    CreateTaskDiscardDialog(
        visible = confirmDiscard,
        onKeep = { confirmDiscard = false },
        onDiscard = { confirmDiscard = false; onBack() },
    )
}

/** Compact Linear assignee chip: optional avatar + alias, accent ring when selected. */
@Composable
private fun CreateAssigneeChip(label: String, selected: Boolean, avatar: Boolean = false, status: String? = null, model: String? = null, onClick: () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(999.dp)
    Row(
        Modifier
            .heightIn(min = 48.dp)
            .semantics { this.selected = selected; role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .background(if (selected) p.lSelected else p.surface, shape)
                .border(1.dp, if (selected) p.accentLine else p.border, shape)
                .clickable(onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (avatar) LAvatar(label, isAI = true, size = 18.dp, status = status)
            Text(label, style = ltype(LType.Meta), color = if (selected) p.text else p.text2, maxLines = 1)
            io.openorcha.mobile.ui.components.ModelProviderMark(model, size = 12.dp)
        }
    }
}
