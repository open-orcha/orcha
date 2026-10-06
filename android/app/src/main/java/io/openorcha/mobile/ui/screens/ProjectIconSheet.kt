package io.openorcha.mobile.ui.screens

/* D14 — Settings › General › Project › Icon (portal EmojiPicker / ProjectIconPicker parity).
   Emoji | Icons tabs: an emoji typed or pasted (validated like the backend's is_emoji) or a
   quick pick; a searchable Lucide glyph grid plus an optional palette colour ("No colour" +
   10 hues). A glyph pick saves and keeps the sheet open so a colour can follow; an emoji pick
   or "Remove icon" saves and closes. Owner or manage_autonomy holders edit; everyone else
   sees the icon and why they can't change it. `PUT /api/containers/{cid}/icon`. */

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.ProjectApi
import io.openorcha.mobile.data.ProjectIconApi
import io.openorcha.mobile.data.ProjectMembersResponse
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.ProjectAuthority
import io.openorcha.mobile.domain.ProjectIconValue
import io.openorcha.mobile.domain.ProjectIcons
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LSearchField
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ProjectIconTile
import io.openorcha.mobile.ui.components.lSelected
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.projectGlyphColor
import io.openorcha.mobile.ui.icons.ProjectGlyphs
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch

private enum class IconTab { Emoji, Glyph }

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ProjectIconSheet(
    container: StoredContainer,
    projectName: String,
    icon: ProjectIconValue?,
    onDismiss: () -> Unit,
    onSaved: (ProjectIconValue?) -> Unit,
) {
    val p = Orcha.palette
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf(icon) }
    var tab by remember { mutableStateOf(if (icon is ProjectIconValue.Glyph) IconTab.Glyph else IconTab.Emoji) }
    var color by remember { mutableStateOf((icon as? ProjectIconValue.Glyph)?.color) }
    var emojiDraft by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var members by remember { mutableStateOf<ProjectMembersResponse?>(null) }
    var membersLoaded by remember { mutableStateOf(false) }
    LaunchedEffect(container.id) {
        members = runCatching { ProjectApi.members(container.baseUrl, container.id) }.getOrNull()
        membersLoaded = true
    }
    // Until the roster answers the server decides (a refusal is shown), like the portal's pending gate.
    val canEdit = !membersLoaded || ProjectAuthority.can(members, container.humanAgentId)

    fun save(next: ProjectIconValue?, close: Boolean) {
        if (!canEdit || busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { ProjectIconApi.setIcon(container.baseUrl, container.id, container.humanAgentId, next) }
                .onSuccess {
                    value = next
                    onSaved(next)
                    if (close) onDismiss()
                }
                .onFailure { error = "Couldn't save the icon — " + routineErrorText(it).replace("manage routines", "change the icon") + "." }
            busy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = Modifier.statusBarsPadding(),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 18.dp).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.m)) {
                ProjectIconTile(value, size = 40.dp)
                Column(Modifier.weight(1f)) {
                    Text("Project icon", style = ltype(LType.Headline), color = p.text, modifier = Modifier.semantics { heading() })
                    Text("Everyone on $projectName sees it, here and in the portal.", style = ltype(LType.Meta), color = p.muted)
                }
            }
            error?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
            if (!canEdit) {
                Text(
                    "Only the project owner or someone allowed to manage autonomy can change the icon.",
                    style = ltype(LType.Body), color = p.text2,
                )
                return@Column
            }
            LSegmented(listOf(IconTab.Emoji to "Emoji", IconTab.Glyph to "Icons"), tab, { tab = it; query = "" })
            when (tab) {
                IconTab.Emoji -> {
                    val draft = emojiDraft.trim()
                    val valid = ProjectIcons.isEmoji(draft)
                    OrchaField(
                        emojiDraft, { emojiDraft = it }, label = "Emoji", placeholder = "Type or paste an emoji", maxLines = 1,
                        isError = draft.isNotEmpty() && !valid,
                        supporting = if (draft.isNotEmpty() && !valid) "That isn't one emoji." else "Use your keyboard's emoji picker, or pick one below.",
                    )
                    LButton(
                        if (valid) "Use $draft" else "Use emoji",
                        { save(ProjectIconValue.Emoji(draft), close = true) },
                        kind = LButtonKind.Primary, size = LSize.Small, enabled = valid && !busy,
                    )
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        ProjectIcons.QUICK_EMOJI.forEach { e ->
                            PickCell(
                                selected = (value as? ProjectIconValue.Emoji)?.value == e,
                                label = e, enabled = !busy,
                                onClick = { save(ProjectIconValue.Emoji(e), close = true) },
                            ) { Text(e, fontSize = 22.sp, maxLines = 1) }
                        }
                    }
                }
                IconTab.Glyph -> {
                    LSearchField(query, { query = it }, placeholder = "Search icons")
                    val names = ProjectIcons.searchGlyphs(query, ProjectGlyphs.WORDS)
                    if (names.isEmpty()) {
                        Text("No icon matches “${query.trim()}”.", style = ltype(LType.Meta), color = p.muted)
                    } else {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            names.forEach { name ->
                                PickCell(
                                    selected = (value as? ProjectIconValue.Glyph)?.name == name,
                                    label = name, enabled = !busy,
                                    onClick = { save(ProjectIconValue.Glyph(name, color), close = false) },
                                ) {
                                    ProjectGlyphs.vector(name)?.let {
                                        Icon(it, null, tint = projectGlyphColor(color) ?: p.text2, modifier = Modifier.size(20.dp))
                                    }
                                }
                            }
                        }
                    }
                    Text("Colour", style = ltype(LType.Meta), color = p.muted, modifier = Modifier.semantics { heading() })
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        (listOf<Int?>(null) + ProjectIcons.AVATAR_HUES.indices).forEach { slot ->
                            val swatch = projectGlyphColor(slot)
                            PickCell(
                                selected = color == slot,
                                label = slot?.let { ProjectIcons.HUE_NAMES[it] } ?: "No colour",
                                enabled = !busy,
                                role = Role.RadioButton,
                                onClick = {
                                    color = slot
                                    (value as? ProjectIconValue.Glyph)?.let { save(it.copy(color = slot), close = false) }
                                },
                            ) {
                                Box(
                                    Modifier.size(18.dp)
                                        .background(swatch ?: Color.Transparent, CircleShape)
                                        .then(if (swatch == null) Modifier.border(1.dp, p.muted, CircleShape) else Modifier),
                                )
                            }
                        }
                    }
                    if (value !is ProjectIconValue.Glyph) {
                        Text("Pick an icon to apply this colour.", style = ltype(LType.Micro), color = p.faint)
                    }
                }
            }
            if (value != null) {
                LButton("Remove icon", { save(null, close = true) }, kind = LButtonKind.Ghost, size = LSize.Small, enabled = !busy)
            }
        }
    }
}

/** One 48dp picker cell (emoji, glyph or colour swatch) with a selected background. */
@Composable
private fun PickCell(
    selected: Boolean,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    role: Role = Role.Button,
    content: @Composable () -> Unit,
) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(8.dp)
    Box(
        Modifier
            .size(48.dp)
            .background(if (selected) p.lSelected else Color.Transparent, shape)
            .then(if (selected) Modifier.border(1.dp, p.accentLine, shape) else Modifier)
            .clickable(enabled = enabled, role = role, onClick = onClick)
            .semantics { contentDescription = label; this.selected = selected },
        contentAlignment = Alignment.Center,
    ) { content() }
}
