package io.openorcha.mobile.domain

import io.openorcha.mobile.data.DeliverableDto
import io.openorcha.mobile.data.DeliverableVersionDto
import io.openorcha.mobile.data.TaskDto
import kotlinx.serialization.json.Json
import java.util.Locale

/**
 * Pure copy + logic for task deliverables. Wording mirrors the web portal
 * (`pages/tasks/deliverables/api.ts`, `DeliverablesSection.tsx`, `DeliverablePreview.tsx`,
 * `DeliverableDiff.tsx`) so the three clients read the same.
 */
object DeliverablesUx {

    /** How the phone previews a kind. Anything unknown goes to the browser. */
    enum class Preview { Markdown, Csv, Json, Text, Image, Pdf, Browser }

    val TEXT_KINDS = setOf("markdown", "text", "csv", "json")

    fun preview(kind: String): Preview = when (kind) {
        "markdown" -> Preview.Markdown
        "csv" -> Preview.Csv
        "json" -> Preview.Json
        "text" -> Preview.Text
        "image" -> Preview.Image
        "pdf" -> Preview.Pdf
        else -> Preview.Browser
    }

    fun kindLabel(kind: String): String = when (kind) {
        "markdown" -> "Markdown document"
        "text" -> "Text file"
        "json" -> "JSON file"
        "csv" -> "Table (CSV)"
        "pdf" -> "PDF document"
        "image" -> "Image"
        else -> "File"
    }

    /** Web `formatBytes`. */
    fun formatBytes(n: Long?): String {
        if (n == null || n < 0) return "—"
        if (n < 1024) return "$n B"
        if (n < 1024 * 1024) {
            val kb = n / 1024.0
            return (if (n < 10 * 1024) String.format(Locale.US, "%.1f", kb) else String.format(Locale.US, "%.0f", kb)) + " KB"
        }
        return String.format(Locale.US, "%.1f", n / (1024.0 * 1024.0)) + " MB"
    }

    /** "reports/" for "reports/q3.md"; "" at the top level. */
    fun dirOf(path: String): String {
        val i = path.lastIndexOf('/')
        return if (i > 0) path.substring(0, i + 1) else ""
    }

    /** Web `sourceLabel`: "Run output · dev" / "Attached · Hussein". */
    fun sourceLabel(v: DeliverableVersionDto?): String {
        v ?: return ""
        val who = v.authorAlias ?: if (v.source == "run_output") "agent run" else ""
        return (if (v.source == "run_output") "Run output" else "Attached") + if (who.isNotEmpty()) " · $who" else ""
    }

    /** The one-line meta under a row: "v3 · Run output · dev · 12 KB · 2h ago". */
    fun rowMeta(d: DeliverableDto, nowMs: Long = System.currentTimeMillis()): String = listOfNotNull(
        if (d.versionCount > 1) "v${d.latestVersion}" else null,
        sourceLabel(d.latest).ifEmpty { null },
        formatBytes(d.latest?.sizeBytes),
        MobileUx.agoLabel(d.updatedAt, nowMs),
    ).joinToString(" · ")

    /** Spoken row label (TalkBack). */
    fun rowA11y(d: DeliverableDto, nowMs: Long = System.currentTimeMillis()): String =
        "${kindLabel(d.kind)}, ${d.path}, " + rowMeta(d, nowMs).replace(" · ", ", ")

    /** Humans can attach to any open, non-root task (closed tasks are frozen server-side). */
    fun canAttach(task: TaskDto, hasHuman: Boolean): Boolean =
        hasHuman && !task.isRoot && task.status !in setOf("completed", "cancelled")

    fun emptyCopy(outputsFolder: String, canAttach: Boolean): String =
        "None yet. Agents publish files by writing to ${outputsFolder.ifBlank { ".orcha/outputs" }}" +
            if (canAttach) "; you can also attach one." else "."

    /** Web toast after an upload batch. */
    fun uploadNotice(fileName: String, deduplicated: Boolean): String =
        if (deduplicated) "No changes — identical to the latest version" else "Attached $fileName"

    /** The server only accepts allow-listed extensions; check before sending the bytes. */
    fun extensionAllowed(fileName: String, allowed: List<String>): Boolean {
        if (allowed.isEmpty()) return true
        val ext = fileName.substringAfterLast('.', "").lowercase()
        return ext.isNotEmpty() && ext in allowed
    }

    fun tooLargeCopy(maxBytes: Long): String = "File too large (max ${formatBytes(maxBytes)})."

    fun truncatedCopy(maxBytes: Long, sizeBytes: Long): String =
        "Preview shows the first ${formatBytes(maxBytes)} of ${formatBytes(sizeBytes)} — open in the browser for the full file."

    /** "v1 → v3: file changed (1.2 KB → 4.0 KB). Binary files have no text diff — preview each version to compare." */
    fun binaryDiffCopy(from: DeliverableVersionDto, to: DeliverableVersionDto, changed: Boolean): String =
        "v${from.version} → v${to.version}: ${if (changed) "file changed" else "no change"} " +
            "(${formatBytes(from.sizeBytes)} → ${formatBytes(to.sizeBytes)}). Binary files have no text diff — preview each version to compare."

    private val pretty = Json { prettyPrint = true }

    /** Web `prettyJson`: pretty-print when it parses, else the text as-is. */
    fun prettyJson(text: String): String =
        runCatching { pretty.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), Json.parseToJsonElement(text)) }
            .getOrDefault(text)

    /** A small CSV/TSV reader (quotes, escaped quotes, CRLF) bounded to [maxRows]. */
    fun parseCsv(text: String, delimiter: Char, maxRows: Int = 200): List<List<String>> {
        val rows = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        val cell = StringBuilder()
        var quoted = false
        var i = 0
        while (i < text.length && rows.size < maxRows) {
            val c = text[i]
            if (quoted) {
                if (c == '"' && i + 1 < text.length && text[i + 1] == '"') { cell.append('"'); i++ }
                else if (c == '"') quoted = false
                else cell.append(c)
            } else when (c) {
                '"' -> if (cell.isEmpty()) quoted = true else cell.append(c)
                delimiter -> { row.add(cell.toString()); cell.clear() }
                '\r' -> Unit
                '\n' -> { row.add(cell.toString()); cell.clear(); rows.add(row); row = mutableListOf() }
                else -> cell.append(c)
            }
            i++
        }
        if (rows.size < maxRows && (cell.isNotEmpty() || row.isNotEmpty())) { row.add(cell.toString()); rows.add(row) }
        return rows
    }

    fun delimiterFor(path: String): Char = if (path.lowercase().endsWith(".tsv")) '\t' else ','

    /** Older versions [selected] can be compared against, newest first. */
    fun compareCandidates(versions: List<DeliverableVersionDto>, selected: Int): List<Int> =
        versions.map { it.version }.filter { it < selected }.sortedDescending()
}
