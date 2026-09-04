package io.openorcha.mobile.ui.screens

/** The PR detail's Files section — split out of GitHubPullDetailScreen.kt to keep that
 *  file lean. Expanding a row renders its unified-diff patch via [DiffViewer] (Android's
 *  #177 gap closed — iOS drops patches server-side and has no diff viewer). */

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.GitHubChangedFile
import io.openorcha.mobile.data.GitHubFiles
import io.openorcha.mobile.domain.DiffParser
import io.openorcha.mobile.ui.components.DiffFileBody
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

@Composable
internal fun FilesSection(files: GitHubFiles, htmlUrl: String? = null) {
    val p = Orcha.palette
    var expandedFile by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionH("Files · ${files.count}")
        OrchaCard {
            if (files.items.isEmpty()) {
                Text("No file changes reported.", color = p.muted)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    files.items.forEach { file ->
                        FileRow(file, htmlUrl, expanded = expandedFile == file.filename) {
                            expandedFile = if (expandedFile == file.filename) null else file.filename
                        }
                    }
                    if (files.truncated) {
                        Text(
                            "Showing the first ${files.items.size} of ${files.count} changed files.",
                            style = MaterialTheme.typography.labelMedium, color = p.faint,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: GitHubChangedFile, htmlUrl: String?, expanded: Boolean, onToggle: () -> Unit) {
    val p = Orcha.palette
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // iOS ChangedFileRow parity: a chevron announces the row expands.
            Icon(
                if (expanded) OrchaIcons.ExpandMore else OrchaIcons.ChevronRight,
                contentDescription = null, tint = p.faint, modifier = Modifier.size(14.dp),
            )
            Text(
                file.filename, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            if (file.additions > 0) Text("+${file.additions}", style = fileCountStyle, color = p.diffAdd)
            if (file.deletions > 0) Text("-${file.deletions}", style = fileCountStyle, color = p.diffDel)
        }
        if (expanded) {
            val patch = file.patch
            Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (patch.isNullOrBlank()) {
                    // iOS omittedNote parity: oversized vs not-served, with the PR link
                    // as fallback (GitHub has no stable per-file anchor).
                    Text(
                        if (file.patchOmitted) "This diff is too large to show here."
                        else "This diff isn't available from this server yet.",
                        style = MaterialTheme.typography.labelMedium, color = p.muted,
                    )
                    if (htmlUrl != null) {
                        Text(
                            "View on GitHub",
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.W600),
                            color = p.accent,
                            modifier = Modifier.clickable {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(htmlUrl)))
                            },
                        )
                    }
                } else {
                    // iOS ChangedFileRow parity: this row already IS the collapsible
                    // header, so render the hunk body directly — nesting the full
                    // DiffViewer duplicated the summary + per-file header inside.
                    val parsed = remember(patch) { DiffParser.parse(patch) }
                    if (parsed.isEmpty()) {
                        Text("No net change (empty diff).", style = MaterialTheme.typography.labelMedium, color = p.faint)
                    } else {
                        parsed.forEach { parsedFile -> DiffFileBody(parsedFile) }
                    }
                }
            }
        }
    }
}

private val fileCountStyle = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W600, fontSize = 11.sp)
