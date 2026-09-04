package io.openorcha.mobile.ui.components

/**
 * A real unified-diff viewer (GitHub-app anatomy): a changes summary, one collapsible
 * section per file, hunk headers, dual line-number gutters, and full-width add/del row
 * tints with a darker gutter shade. Long lines scroll horizontally per file — gutters
 * ride along, GitHub-style. This is Android's #177 gap closed: iOS has no diff viewer
 * (its server drops patches), so this goes beyond parity using the `diffAdd/diffAddBg/
 * diffDel/diffDelBg/diffHunk/diffHunkBg` palette tokens reserved for exactly this.
 * Parsing lives in [io.openorcha.mobile.domain.DiffParser] (pure, unit-tested); this file
 * is presentation only.
 */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.domain.DiffFile
import io.openorcha.mobile.domain.DiffParser
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/** Very large files start collapsed so a big sweep stays scrollable. */
private const val AUTO_COLLAPSE_LINE_THRESHOLD = 800

@Composable
fun DiffViewer(diff: String, modifier: Modifier = Modifier) {
    val files = remember(diff) { DiffParser.parse(diff) }
    val p = Orcha.palette
    if (files.isEmpty()) {
        OrchaCard(modifier) {
            Text("No net change (empty diff).", color = p.muted, style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    val totalAdds = remember(files) { files.sumOf { it.adds } }
    val totalDels = remember(files) { files.sumOf { it.dels } }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "${files.size} file${if (files.size == 1) "" else "s"} changed",
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.W700),
                color = p.text,
            )
            if (totalAdds > 0) {
                Text("+$totalAdds", style = diffCountStyle, color = p.diffAdd)
            }
            if (totalDels > 0) {
                Text("−$totalDels", style = diffCountStyle, color = p.diffDel)
            }
        }
        files.forEach { file -> DiffFileSection(file) }
    }
}

private val diffCountStyle = TextStyle(
    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W700, fontSize = 13.sp,
)

@Composable
private fun DiffFileSection(file: DiffFile, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val lineCount = remember(file) { file.hunks.sumOf { it.lines.size } }
    var expanded by remember(file.id) { mutableStateOf(lineCount <= AUTO_COLLAPSE_LINE_THRESHOLD) }

    Column(
        modifier
            .fillMaxWidth()
            .background(p.surface, RoundedCornerShape(12.dp))
            .border(BorderStroke(1.dp, p.border), RoundedCornerShape(12.dp)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(p.surface2, RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp))
                .clickable { expanded = !expanded }
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (expanded) OrchaIcons.ExpandMore else OrchaIcons.ChevronRight,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint = p.faint,
                modifier = Modifier.width(16.dp),
            )
            Text(
                file.path,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W600, fontSize = 12.5.sp),
                color = p.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.weight(1f))
            if (file.adds > 0) Text("+${file.adds}", style = diffCountStyle.copy(fontSize = 11.5.sp), color = p.diffAdd)
            if (file.dels > 0) Text("−${file.dels}", style = diffCountStyle.copy(fontSize = 11.5.sp), color = p.diffDel)
        }

        if (expanded) {
            if (file.isBinary) {
                Text(
                    "Binary file — no textual diff.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = p.muted,
                    modifier = Modifier.padding(12.dp),
                )
            } else if (file.hunks.isEmpty()) {
                Text(
                    "No diff available for this file.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = p.muted,
                    modifier = Modifier.padding(12.dp),
                )
            } else {
                DiffFileBody(file)
            }
        } else if (!file.isBinary) {
            Text(
                "$lineCount lines — tap to expand",
                style = MaterialTheme.typography.labelMedium,
                color = p.faint,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

