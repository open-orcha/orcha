package io.openorcha.mobile.ui.screens

/**
 * Task deliverables (web P2 parity): the non-code files a task produced, as Linear-calm rows
 * (kind badge, mono path, version, who produced it, size, age). A row opens a sheet with the
 * preview for the selected version (markdown / table / JSON / text, images, PDFs page by
 * page), its version history, and "Compare" — the text diff against an earlier version in the
 * shared [DiffViewer]. Humans attach a file through the system picker (a write the server
 * re-checks; closed tasks are frozen).
 */

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.DeliverableDiffDto
import io.openorcha.mobile.data.DeliverableDto
import io.openorcha.mobile.data.DeliverableTextDto
import io.openorcha.mobile.data.DeliverableVersionDto
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.data.endpoint
import io.openorcha.mobile.domain.DeliverablesUx
import io.openorcha.mobile.domain.DeliverablesUx.Preview
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.TaskDeliverablesController
import io.openorcha.mobile.ui.TaskDeliverablesState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.DiffViewer
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.MarkdownText
import io.openorcha.mobile.ui.components.RawImagePreview
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/* ---------- picker (Storage Access Framework) ---------- */

/** MIME filters for the system picker; the server's extension allow-list is re-checked before upload. */
private val PICKER_TYPES = arrayOf("text/*", "application/json", "application/pdf", "image/*")

/**
 * Registers the system file picker at screen level (so the result survives the list item
 * scrolling away). [onPicked] gets the display name, MIME type and a lazy byte reader.
 */
@Composable
internal fun rememberDeliverablePicker(onPicked: (name: String, mime: String, read: () -> ByteArray?) -> Unit): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        val resolver = context.contentResolver
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        onPicked(name, mime) { runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() }
    }
    return { launcher.launch(PICKER_TYPES) }
}

/* ---------- the section ---------- */

@Composable
internal fun TaskDeliverablesSection(
    state: TaskDeliverablesState,
    canAttach: Boolean,
    onAttach: () -> Unit,
    onOpen: (DeliverableDto) -> Unit,
) {
    val p = Orcha.palette
    LSection(
        "Deliverables",
        count = state.items.size.takeIf { it > 0 },
        trailing = {
            if (state.uploading) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = p.accent)
                }
            } else if (canAttach) {
                IconButton(onClick = onAttach) { Icon(OrchaIcons.Add, "Attach deliverable", tint = p.text2) }
            }
        },
    ) {
        state.uploadError?.let { Banner(BannerKind.Danger, it) }
        when {
            state.loading && state.items.isEmpty() ->
                Text("Loading deliverables…", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(horizontal = 4.dp))
            state.error != null ->
                Text(state.error, style = ltype(LType.Meta), color = p.danger, modifier = Modifier.padding(horizontal = 4.dp))
            state.items.isEmpty() ->
                Text(
                    DeliverablesUx.emptyCopy(state.limits.outputsFolder, canAttach),
                    style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(horizontal = 4.dp),
                )
            else -> Column {
                state.items.forEachIndexed { i, d ->
                    if (i > 0) LDivider(Modifier.padding(start = 44.dp))
                    DeliverableRow(d) { onOpen(d) }
                }
            }
        }
    }
}

@Composable
private fun KindBadge(kind: String) {
    val p = Orcha.palette
    val label = when (kind) {
        "markdown" -> "MD"; "text" -> "TXT"; "csv" -> "CSV"; "json" -> "JSON"; "pdf" -> "PDF"; "image" -> "IMG"; else -> "FILE"
    }
    Box(
        Modifier
            .widthIn(min = 34.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(p.surface2)
            .border(1.dp, p.border, RoundedCornerShape(4.dp))
            .padding(horizontal = 4.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = ltype(LType.Micro), color = p.text2, maxLines = 1) }
}

@Composable
private fun DeliverableRow(d: DeliverableDto, onClick: () -> Unit) {
    val p = Orcha.palette
    val a11y = DeliverablesUx.rowA11y(d)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 4.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) { contentDescription = a11y },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        KindBadge(d.kind)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row {
                val dir = DeliverablesUx.dirOf(d.path)
                if (dir.isNotEmpty()) Text(dir, style = ltype(LType.Mono), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(d.name, style = ltype(LType.Mono), color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(DeliverablesUx.rowMeta(d), style = ltype(LType.Meta), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(14.dp))
    }
}

/* ---------- the detail sheet ---------- */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeliverableSheet(
    controller: TaskDeliverablesController,
    container: StoredContainer,
    taskId: String,
    deliverable: DeliverableDto,
    tasks: List<TaskDto>,
    onOpenTask: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val p = Orcha.palette
    val uri = LocalUriHandler.current
    var full by remember(deliverable.id) { mutableStateOf(deliverable) }
    var historyError by remember(deliverable.id) { mutableStateOf<String?>(null) }
    var selected by remember(deliverable.id) { mutableIntStateOf(deliverable.latestVersion) }
    var compareFrom by remember(deliverable.id) { mutableStateOf<Int?>(null) }
    LaunchedEffect(deliverable.id, deliverable.latestVersion) {
        controller.detail(container, taskId, deliverable.id)
            .onSuccess { full = it; historyError = null }
            .onFailure { historyError = "History unavailable — " + controller.describe(it).trimEnd('.') + "." }
    }
    val versions = full.versions ?: listOfNotNull(full.latest)
    val current = versions.firstOrNull { it.version == selected } ?: full.latest
    val older = DeliverablesUx.compareCandidates(versions, selected)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = p.surface,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = LSpace.l).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(full.name, style = ltype(LType.Title), color = p.text, modifier = Modifier.semantics { heading() })
                Text(
                    listOfNotNull(DeliverablesUx.kindLabel(full.kind), DeliverablesUx.dirOf(full.path).ifEmpty { null }).joinToString(" · "),
                    style = ltype(LType.Meta), color = p.faint,
                )
            }
            if (versions.size > 1) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    versions.forEach { v ->
                        LChip(
                            "v${v.version}" + if (v.version == full.latestVersion) " (latest)" else "",
                            selected = v.version == selected,
                            onClick = {
                                selected = v.version
                                if ((compareFrom ?: 0) >= v.version) compareFrom = null
                            },
                        )
                    }
                }
            }
            current?.let { v ->
                Text(
                    listOfNotNull("Version ${v.version}", DeliverablesUx.sourceLabel(v), DeliverablesUx.formatBytes(v.sizeBytes), MobileUx.agoLabel(v.createdAt))
                        .joinToString(" · "),
                    style = ltype(LType.Meta), color = p.text2,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalAlignment = Alignment.CenterVertically) {
                if (older.isNotEmpty()) {
                    if (compareFrom == null) {
                        LButton("Compare with v${older.first()}", { compareFrom = older.first() }, size = LSize.Small)
                    } else {
                        LButton("Preview", { compareFrom = null }, size = LSize.Small)
                    }
                }
                current?.let { v ->
                    LButton(
                        "Open in browser",
                        { runCatching { uri.openUri(container.baseUrl.endpoint() + v.rawUrl) } },
                        icon = OrchaIcons.OpenInNew,
                        kind = LButtonKind.Ghost,
                        size = LSize.Small,
                    )
                }
            }
            val from = compareFrom
            if (from != null && older.size > 1) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    older.forEach { o -> LChip("against v$o", selected = o == from, onClick = { compareFrom = o }) }
                }
            }
            historyError?.let { Text(it, style = ltype(LType.Meta), color = p.danger) }
            when {
                current == null -> Text("No version recorded.", style = ltype(LType.Meta), color = p.faint)
                from != null -> DeliverableDiffView(controller, container, taskId, full, from, selected)
                else -> DeliverablePreview(controller, container, full, current, tasks, onOpenTask)
            }
            current?.note?.takeIf { it.isNotBlank() }?.let { Text("Note: $it", style = ltype(LType.Meta), color = p.text2) }
            if (versions.size > 1) {
                Text("Version history", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.semantics { heading() })
                Column {
                    versions.forEach { v ->
                        VersionRow(v, isSelected = v.version == selected) {
                            selected = v.version
                            if ((compareFrom ?: 0) >= v.version) compareFrom = null
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun VersionRow(v: DeliverableVersionDto, isSelected: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(if (isSelected) p.surface2 else p.surface)
            .clickable(onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = LSpace.s, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Text("v${v.version}", style = ltype(LType.Mono), color = if (isSelected) p.accent else p.text)
        Column(Modifier.weight(1f)) {
            Text(DeliverablesUx.sourceLabel(v), style = ltype(LType.Meta), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            (v.note ?: v.runId?.let { "run ${it.take(8)}" })?.let {
                Text(it, style = ltype(LType.Micro), color = p.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(
            listOfNotNull(DeliverablesUx.formatBytes(v.sizeBytes), MobileUx.agoLabel(v.createdAt)).joinToString(" · "),
            style = ltype(LType.Micro), color = p.faint,
        )
    }
}

/* ---------- preview by kind ---------- */

private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val message: String) : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
}

@Composable
private fun DeliverablePreview(
    controller: TaskDeliverablesController,
    container: StoredContainer,
    d: DeliverableDto,
    v: DeliverableVersionDto,
    tasks: List<TaskDto>,
    onOpenTask: (String) -> Unit,
) {
    val p = Orcha.palette
    val mode = DeliverablesUx.preview(d.kind)
    when (mode) {
        Preview.Image -> RawImagePreview(key = "${d.id}:${v.version}", description = "${d.name} (version ${v.version})") {
            controller.raw(container, v.rawUrl)
        }
        Preview.Pdf -> PdfPreview(key = "${d.id}:${v.version}", description = "${d.name} (version ${v.version})") {
            controller.raw(container, v.rawUrl)
        }
        Preview.Browser -> Text(
            "This file type can't be previewed on the phone — open it in the browser.",
            style = ltype(LType.Meta), color = p.faint,
        )
        else -> {
            val url = v.textUrl
            var st by remember(url) { mutableStateOf<Load<DeliverableTextDto>>(Load.Loading) }
            LaunchedEffect(url) {
                st = if (url == null) Load.Failed("Preview unavailable.")
                else controller.text(container, url).fold(
                    { Load.Ready(it) },
                    { Load.Failed("Preview unavailable — " + controller.describe(it).trimEnd('.') + ".") },
                )
            }
            when (val s = st) {
                Load.Loading -> Text("Loading preview…", style = ltype(LType.Meta), color = p.faint)
                is Load.Failed -> Text(s.message, style = ltype(LType.Meta), color = p.danger)
                is Load.Ready -> {
                    val t = s.value
                    PreviewFrame {
                        when (mode) {
                            Preview.Markdown -> MarkdownText(t.text, Modifier.padding(LSpace.m), tasks = tasks, onOpenTask = onOpenTask)
                            Preview.Csv -> CsvTable(t.text, d.path)
                            Preview.Json -> MonoText(if (t.truncated) t.text else DeliverablesUx.prettyJson(t.text))
                            else -> MonoText(t.text)
                        }
                    }
                    if (t.truncated) Text(DeliverablesUx.truncatedCopy(t.maxBytes, v.sizeBytes), style = ltype(LType.Meta), color = p.faint)
                }
            }
        }
    }
}

@Composable
private fun PreviewFrame(content: @Composable () -> Unit) {
    val p = Orcha.palette
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(p.surface2, shape).border(1.dp, p.border, shape)) { content() }
}

@Composable
private fun MonoText(text: String) {
    val p = Orcha.palette
    Text(
        text,
        style = ltype(LType.Mono).copy(fontFamily = FontFamily.Monospace),
        color = p.text,
        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(LSpace.m),
    )
}

private const val MAX_TABLE_ROWS = 200
private const val MAX_TABLE_COLS = 40

@Composable
private fun CsvTable(text: String, path: String) {
    val p = Orcha.palette
    val rows = remember(text, path) { DeliverablesUx.parseCsv(text, DeliverablesUx.delimiterFor(path), MAX_TABLE_ROWS + 1) }
    if (rows.isEmpty()) {
        Text("Empty table.", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(LSpace.m)); return
    }
    val cols = minOf(rows.maxOf { it.size }, MAX_TABLE_COLS)
    Column(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 4.dp)) {
        rows.take(MAX_TABLE_ROWS + 1).forEachIndexed { ri, r ->
            Row(Modifier.background(if (ri == 0) p.surface else p.surface2)) {
                for (c in 0 until cols) {
                    Text(
                        r.getOrNull(c).orEmpty(),
                        style = ltype(if (ri == 0) LType.BodyEmph else LType.Meta),
                        color = if (ri == 0) p.text else p.text2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(min = 64.dp, max = 220.dp).padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}

/* ---------- PDF: one page at a time through android.graphics.pdf.PdfRenderer ---------- */

/** Rendered page width — sharp on a phone without holding big bitmaps. */
private const val PDF_RENDER_WIDTH = 1200

@Composable
private fun PdfPreview(key: String, description: String, load: suspend () -> ByteArray) {
    val p = Orcha.palette
    val context = LocalContext.current
    var file by remember(key) { mutableStateOf<Load<Pair<File, Int>>>(Load.Loading) }
    var page by remember(key) { mutableIntStateOf(0) }
    var bitmap by remember(key) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(key) {
        file = runCatching {
            val bytes = load()
            withContext(Dispatchers.IO) {
                val f = File(context.cacheDir, "deliverable-${key.hashCode()}.pdf")
                f.writeBytes(bytes)
                ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY).use { fd -> PdfRenderer(fd).use { f to it.pageCount } }
            }
        }.fold({ Load.Ready(it) }, { Load.Failed("This PDF can't be previewed on the phone — open it in the browser.") })
    }
    DisposableEffect(key) {
        onDispose { (file as? Load.Ready)?.value?.first?.delete() }
    }
    val ready = file as? Load.Ready
    LaunchedEffect(ready, page) {
        val (f, count) = ready?.value ?: return@LaunchedEffect
        if (count == 0) return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) { runCatching { renderPdfPage(f, page) }.getOrNull() }
    }
    when (val s = file) {
        Load.Loading -> Text("Loading preview…", style = ltype(LType.Meta), color = p.faint)
        is Load.Failed -> Text(s.message, style = ltype(LType.Meta), color = p.faint)
        is Load.Ready -> {
            val count = s.value.second
            Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                PreviewFrame {
                    val bmp = bitmap
                    if (bmp == null) {
                        Text("Rendering page…", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(LSpace.m))
                    } else {
                        Image(
                            bmp.asImageBitmap(),
                            contentDescription = "$description, page ${page + 1} of $count",
                            contentScale = ContentScale.FillWidth,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (count > 1) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        LButton("Previous", { page -= 1 }, kind = LButtonKind.Ghost, size = LSize.Small, enabled = page > 0)
                        Text(
                            "Page ${page + 1} of $count",
                            style = ltype(LType.Meta), color = p.text2,
                            modifier = Modifier.weight(1f),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        LButton("Next", { page += 1 }, kind = LButtonKind.Ghost, size = LSize.Small, enabled = page < count - 1)
                    }
                }
            }
        }
    }
}

private fun renderPdfPage(f: File, index: Int): Bitmap =
    ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { r ->
            r.openPage(index.coerceIn(0, r.pageCount - 1)).use { pg ->
                val w = PDF_RENDER_WIDTH
                val h = (w.toFloat() * pg.height / pg.width.coerceAtLeast(1)).toInt().coerceIn(1, w * 4)
                Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bmp ->
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    pg.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
            }
        }
    }

/* ---------- diff ---------- */

@Composable
private fun DeliverableDiffView(
    controller: TaskDeliverablesController,
    container: StoredContainer,
    taskId: String,
    d: DeliverableDto,
    from: Int,
    to: Int,
) {
    val p = Orcha.palette
    var st by remember(d.id, from, to) { mutableStateOf<Load<DeliverableDiffDto>>(Load.Loading) }
    LaunchedEffect(d.id, from, to) {
        st = controller.diff(container, taskId, d.id, from, to).fold(
            { Load.Ready(it) },
            { Load.Failed("Diff unavailable — " + controller.describe(it).trimEnd('.') + ".") },
        )
    }
    when (val s = st) {
        Load.Loading -> Text("Loading changes…", style = ltype(LType.Meta), color = p.faint)
        is Load.Failed -> Text(s.message, style = ltype(LType.Meta), color = p.danger)
        is Load.Ready -> {
            val r = s.value
            val label = "v${r.fromVersion.version} → v${r.toVersion.version}"
            when {
                r.binary && r.kind == "image" && r.bytesChanged -> Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    Text("Before · v${r.fromVersion.version}", style = ltype(LType.Meta), color = p.text2)
                    RawImagePreview(key = "${d.id}:${r.fromVersion.version}", description = "${d.name}, version ${r.fromVersion.version}") {
                        controller.raw(container, r.fromVersion.rawUrl)
                    }
                    Text("After · v${r.toVersion.version}", style = ltype(LType.Meta), color = p.text2)
                    RawImagePreview(key = "${d.id}:${r.toVersion.version}", description = "${d.name}, version ${r.toVersion.version}") {
                        controller.raw(container, r.toVersion.rawUrl)
                    }
                }
                r.binary -> Text(DeliverablesUx.binaryDiffCopy(r.fromVersion, r.toVersion, r.bytesChanged), style = ltype(LType.Meta), color = p.text2)
                r.identical || r.diff.isNullOrBlank() -> Text("$label: no text changes.", style = ltype(LType.Meta), color = p.text2)
                else -> Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                    Text("${d.path} · $label · +${r.added} −${r.removed}", style = ltype(LType.Meta), color = p.text2)
                    DiffViewer(r.diff)
                    if (r.truncated) {
                        Text(
                            "Diff truncated (large file) — open both versions in the browser for the full comparison.",
                            style = ltype(LType.Meta), color = p.faint,
                        )
                    }
                }
            }
        }
    }
}
