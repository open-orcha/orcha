package io.openorcha.mobile.ui.components

/** The diff viewer's scrolling code block: hunk headers + add/del/context line rows with
 *  dual gutters. Split out of DiffViewer.kt to keep that file lean — file-section chrome
 *  (collapse/expand, header, counts) lives there; the actual code rendering lives here. */

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.domain.DiffFile
import io.openorcha.mobile.domain.DiffHunk
import io.openorcha.mobile.domain.DiffLine
import io.openorcha.mobile.domain.DiffLineKind
import io.openorcha.mobile.ui.theme.Orcha

internal val monoCodeSize = 12.sp
internal val gutterWidth = 34.dp

/** The scrolling code block: one shared horizontal scroller for gutters + code so both
 *  gutters and the code column stay aligned as the user scrolls a long line. */
@Composable
internal fun DiffFileBody(file: DiffFile) {
    val scrollState = rememberScrollState()
    val maxChars = remember(file) {
        file.hunks.flatMap { it.lines }.maxOfOrNull { it.text.length + 2 } ?: 60
    }
    // pathological one-liners stay scrollable, not absurdly wide
    val codeWidthCh = minOf(maxOf(maxChars, 60), 400)

    Column(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState),
    ) {
        file.hunks.forEach { hunk ->
            HunkHeaderRow(hunk, codeWidthCh)
            hunk.lines.forEach { line -> DiffLineRow(line, codeWidthCh) }
        }
    }
}

@Composable
private fun HunkHeaderRow(hunk: DiffHunk, codeWidthCh: Int) {
    val p = Orcha.palette
    Text(
        hunk.header,
        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 11.5.sp),
        color = p.diffHunk,
        modifier = Modifier
            .background(p.diffHunkBg)
            .widthIn(min = (gutterWidth * 2) + charWidth() * codeWidthCh)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@Composable
private fun DiffLineRow(line: DiffLine, codeWidthCh: Int) {
    val p = Orcha.palette
    val rowBg = when (line.kind) {
        DiffLineKind.Add -> p.diffAddBg
        DiffLineKind.Del -> p.diffDelBg
        DiffLineKind.Context, DiffLineKind.Meta -> Color.Transparent
    }
    val gutterBg = when (line.kind) {
        DiffLineKind.Add -> p.diffAddBg
        DiffLineKind.Del -> p.diffDelBg
        DiffLineKind.Context, DiffLineKind.Meta -> p.surface2.copy(alpha = 0.6f)
    }
    val marker = when (line.kind) {
        DiffLineKind.Add -> "+"
        DiffLineKind.Del -> "−"
        DiffLineKind.Context -> " "
        DiffLineKind.Meta -> ""
    }
    val markerColor = when (line.kind) {
        DiffLineKind.Add -> p.diffAdd
        DiffLineKind.Del -> p.diffDel
        DiffLineKind.Context, DiffLineKind.Meta -> p.faint
    }

    Row(Modifier.fillMaxWidth()) {
        DiffGutter(line.oldNo, gutterBg)
        DiffGutter(line.newNo, gutterBg)
        Row(
            Modifier
                .widthIn(min = charWidth() * codeWidthCh)
                .background(rowBg)
                .padding(horizontal = 8.dp, vertical = 1.5.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                marker,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W700, fontSize = monoCodeSize),
                color = markerColor,
            )
            Text(
                line.text.ifEmpty { " " },
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = monoCodeSize),
                color = if (line.kind == DiffLineKind.Meta) p.faint else p.text,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun DiffGutter(number: Int?, background: Color) {
    Text(
        number?.toString().orEmpty(),
        style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 10.5.sp),
        color = Orcha.palette.faint,
        textAlign = TextAlign.End,
        modifier = Modifier
            .width(gutterWidth)
            .background(background)
            .padding(end = 6.dp, top = 1.5.dp, bottom = 1.5.dp),
    )
}

/** Approximate monospace advance width for one character at [monoCodeSize] — used to size
 *  the scrollable code column so add/del tints span the full scrollable width. */
@Composable
private fun charWidth() = with(androidx.compose.ui.platform.LocalDensity.current) { (monoCodeSize.toPx() * 0.62f).toDp() }
