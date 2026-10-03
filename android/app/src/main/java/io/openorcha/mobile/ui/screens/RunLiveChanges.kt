package io.openorcha.mobile.ui.screens

/**
 * Live changes while the agent works (web LiveChangesPanel parity): a "N files changed
 * +a −d" bar on the run detail, polled every few seconds with `?since=<version>` while
 * the run is live; it opens a sheet with the changed files, and a file opens its diff
 * (or, for an image, a before/after preview from `changes/raw`).
 */

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RunChangeDiffDto
import io.openorcha.mobile.data.RunChangedFileDto
import io.openorcha.mobile.data.RunChangesDto
import io.openorcha.mobile.data.getRunChangeDiff
import io.openorcha.mobile.data.getRunChangeRaw
import io.openorcha.mobile.data.getRunChanges
import io.openorcha.mobile.domain.AgentInsights
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.DiffViewer
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.RawImagePreview
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.pulsing
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.delay

private const val LIVE_POLL_MS = 4_000L

/** Polls the run's changes; renders nothing until there is at least one changed file. */
@Composable
internal fun RunChangesBar(baseUrl: String, agentId: String, runId: String, running: Boolean) {
    val p = Orcha.palette
    var changes by remember(runId) { mutableStateOf<RunChangesDto?>(null) }
    var open by remember { mutableStateOf(false) }

    LaunchedEffect(baseUrl, runId, running) {
        while (true) {
            val since = changes?.version
            runCatching { AgentSliceStore.api.getRunChanges(baseUrl, agentId, runId, since) }
                .onSuccess { r -> if (!r.unchanged) changes = r }
            if (!running) break // a finished run's (captured) changes are read once
            delay(LIVE_POLL_MS)
        }
    }
    val c = changes ?: return
    if (!c.available || c.files.isEmpty()) return

    val live = running && c.running
    val label = "${c.summary.files.takeIf { it > 0 } ?: c.files.size} file${if (c.files.size == 1) "" else "s"} changed"
    val shape = RoundedCornerShape(p.radiusCard.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(p.surface, shape)
            .border(1.dp, p.border, shape)
            .clickable(role = Role.Button, onClickLabel = "Show changed files") { open = true }
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = "$label, ${c.summary.additions} additions, ${c.summary.deletions} deletions" +
                    if (live) ", updating live" else ""
            }
            .padding(horizontal = LSpace.m, vertical = LSpace.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Icon(OrchaIcons.Checklist, null, tint = p.text2, modifier = Modifier.size(16.dp))
        Text(label, style = ltype(LType.BodyEmph), color = p.text)
        if (c.summary.additions > 0) Text("+${c.summary.additions}", style = ltype(LType.Mono), color = p.diffAdd)
        if (c.summary.deletions > 0) Text("−${c.summary.deletions}", style = ltype(LType.Mono), color = p.diffDel)
        Spacer(Modifier.weight(1f))
        if (live) Text("Live", style = ltype(LType.Micro), color = p.accent, modifier = Modifier.pulsing())
        Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp))
    }

    if (open) {
        RunChangesSheet(baseUrl, agentId, runId, c, live, onDismiss = { open = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunChangesSheet(
    baseUrl: String,
    agentId: String,
    runId: String,
    changes: RunChangesDto,
    live: Boolean,
    onDismiss: () -> Unit,
) {
    val p = Orcha.palette
    var selected by remember { mutableStateOf<RunChangedFileDto?>(null) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.bg,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = LSpace.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val file = selected
                if (file != null) {
                    IconButton(onClick = { selected = null }) { Icon(OrchaIcons.ArrowBack, "Back to changed files", tint = p.text2) }
                } else {
                    Spacer(Modifier.size(LSpace.s))
                }
                Column(Modifier.weight(1f).padding(horizontal = LSpace.s)) {
                    Text(
                        file?.path?.substringAfterLast('/') ?: "Changes",
                        style = ltype(LType.Headline), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        file?.path ?: (if (live) "Updating while the agent works" else changes.branch?.let { "On $it" } ?: "This run's changes"),
                        style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            LDivider()
            val file = selected
            if (file == null) {
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(changes.files, key = { it.path }) { f ->
                        ChangedFileRow(f) { selected = f }
                        LDivider(inset = LSpace.l)
                    }
                    if (changes.truncated) {
                        item {
                            Text("Only the first files are listed.", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(LSpace.l))
                        }
                    }
                }
            } else {
                ChangedFileDetail(baseUrl, agentId, runId, file, versionKey = changes.version)
            }
        }
    }
}

@Composable
private fun ChangedFileRow(f: RunChangedFileDto, onClick: () -> Unit) {
    val p = Orcha.palette
    val status = AgentInsights.changeStatusLabel(f.status)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(role = Role.Button, onClickLabel = "Open diff", onClick = onClick)
            .padding(horizontal = LSpace.l, vertical = LSpace.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(f.path.substringAfterLast('/'), style = ltype(LType.BodyEmph), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val dir = f.path.substringBeforeLast('/', "")
            Text(
                listOfNotNull(status, dir.ifEmpty { null }, f.origPath?.let { "from $it" }).joinToString(" · "),
                style = ltype(LType.Meta), color = p.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (f.binary) {
            Text(if (AgentInsights.isPreviewableImage(f.path)) "Image" else "Binary", style = ltype(LType.Micro), color = p.faint)
        } else {
            if (f.additions > 0) Text("+${f.additions}", style = ltype(LType.Mono), color = p.diffAdd)
            if (f.deletions > 0) Text("−${f.deletions}", style = ltype(LType.Mono), color = p.diffDel)
        }
    }
}

@Composable
private fun ChangedFileDetail(baseUrl: String, agentId: String, runId: String, file: RunChangedFileDto, versionKey: String?) {
    val p = Orcha.palette
    val image = AgentInsights.isPreviewableImage(file.path)
    val api = AgentSliceStore.api
    val scroll = rememberScrollState()
    Column(
        Modifier.fillMaxWidth().verticalScroll(scroll).padding(LSpace.l),
        verticalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        if (image) {
            ImageSides(file, versionKey) { side -> api.getRunChangeRaw(baseUrl, agentId, runId, file.path, side) }
            return@Column
        }
        var diff by remember(file.path, versionKey) { mutableStateOf<RunChangeDiffDto?>(null) }
        var failed by remember(file.path, versionKey) { mutableStateOf(false) }
        LaunchedEffect(file.path, versionKey) {
            runCatching { api.getRunChangeDiff(baseUrl, agentId, runId, file.path) }
                .onSuccess { diff = it }
                .onFailure { failed = true }
        }
        val d = diff
        when {
            failed -> Text("Couldn't load this file's diff.", style = ltype(LType.Meta), color = p.danger)
            d == null -> Text("Loading diff…", style = ltype(LType.Meta), color = p.faint)
            !d.available -> Text(AgentInsights.changeReasonCopy(d.reason, d.detail), style = ltype(LType.Meta), color = p.muted)
            else -> {
                DiffViewer(
                    d.diff,
                    canPreview = AgentInsights::isPreviewableImage,
                    binaryPreview = { path ->
                        RawImagePreview(key = "$runId:$path:$versionKey", description = "Preview of $path") {
                            api.getRunChangeRaw(baseUrl, agentId, runId, path, "new")
                        }
                    },
                )
                if (d.truncated) Text("Diff truncated — it exceeds the display cap.", style = ltype(LType.Meta), color = p.faint)
            }
        }
    }
}

/** Before / after for a changed image; an added file has no "before", a deleted one no "after". */
@Composable
private fun ImageSides(file: RunChangedFileDto, versionKey: String?, load: suspend (side: String) -> ByteArray) {
    val p = Orcha.palette
    val hasOld = file.status !in setOf("A", "??")
    val hasNew = file.status != "D"
    if (hasOld && hasNew) Text("Before", style = ltype(LType.Micro), color = p.muted)
    if (hasOld) RawImagePreview(key = "${file.path}:old:$versionKey", description = "${file.path} before the run") { load("old") }
    if (hasOld && hasNew) Text("After", style = ltype(LType.Micro), color = p.muted)
    if (hasNew) RawImagePreview(key = "${file.path}:new:$versionKey", description = "${file.path} after the run") { load("new") }
}
