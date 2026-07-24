package io.openorcha.mobile.ui.components

/** Provides colored log lines and structured worker-run feed rows. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.OrchaSelectors
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

@Composable
fun logLineColor(line: String): Color {
    val p = Orcha.palette
    val l = line.lowercase()
    return when {
        "error" in l || "failed" in l || "traceback" in l -> p.danger
        "warn" in l -> p.warn
        "tool" in l || l.startsWith("run ") -> p.accent
        "done" in l || "complete" in l || "finished" in l || "✓" in line -> p.ok
        l.startsWith("[") || l.startsWith("--") -> p.faint
        else -> p.text2
    }
}

@Composable
fun LogLine(line: String) {
    Text(
        line,
        fontFamily = MonoFontFamily,
        fontSize = 11.5.sp,
        lineHeight = 17.sp,
        color = logLineColor(line),
    )
}

/* ---------- worker-run feed rows (web .feed .row-* parity, no raw JSON) ---------- */

@Composable
private fun feedTint(type: String): Color {
    val p = Orcha.palette
    return when (type) {
        "boot" -> p.faint
        "think" -> p.muted
        "tool" -> p.accent
        "result" -> p.text2
        "subagent" -> p.info
        "decision" -> p.violet
        "error" -> p.danger
        "done" -> p.ok
        else -> p.text // narrate
    }
}

/**
 * One classified run-feed row (A2): label tag + body text; narration reads as plain
 * prose, everything else is label-tinted; `detail` starts collapsed and expands on tap
 * (the web's <details> affordance).
 */
@Composable
fun FeedRow(type: String, label: String, text: String, detail: String? = null) {
    val p = Orcha.palette
    var expanded by remember { mutableStateOf(false) }
    val tint = feedTint(type)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (!detail.isNullOrBlank()) Modifier.clickable { expanded = !expanded } else Modifier)
            .padding(vertical = 3.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                label.uppercase(),
                style = MonoSmStyle.copy(fontSize = 9.5.sp, letterSpacing = 0.6.sp),
                color = tint,
                fontWeight = FontWeight.W700,
            )
            if (!detail.isNullOrBlank()) {
                Text(if (expanded) "▾" else "▸", color = p.faint, fontSize = 10.sp)
            }
        }
        if (text.isNotBlank()) {
            Text(
                text,
                style = if (type == "narrate") MaterialTheme.typography.bodyMedium
                else MaterialTheme.typography.bodyMedium.copy(fontFamily = MonoFontFamily, fontSize = 11.5.sp, lineHeight = 16.sp),
                color = if (type == "narrate") p.text else tint,
            )
        }
        if (expanded && !detail.isNullOrBlank()) {
            Text(
                detail,
                fontFamily = MonoFontFamily,
                fontSize = 10.5.sp,
                lineHeight = 15.sp,
                color = p.muted,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Orcha.palette.surface2, RoundedCornerShape(8.dp))
                    .padding(8.dp),
            )
        }
    }
}
