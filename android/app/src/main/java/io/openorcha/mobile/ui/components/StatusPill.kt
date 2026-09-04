package io.openorcha.mobile.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.MonoFontFamily
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.OrchaPalette
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class StatusDomain { Task, Request, Agent, Connection, Run }

/** color / soft-fill / line-border triplet — badges are ALWAYS this shape (foundations §2). */
data class StatusTint(val color: Color, val soft: Color, val line: Color)

/** Semantic color name → tint triplet, per the token file's `statusColor` contract. */
fun OrchaPalette.tint(name: String): StatusTint = when (name) {
    "accent" -> StatusTint(accent, accentSoft, accentLine)
    "ok" -> StatusTint(ok, okSoft, okLine)
    "info" -> StatusTint(info, infoSoft, infoLine)
    "warn" -> StatusTint(warn, warnSoft, warnLine)
    "danger" -> StatusTint(danger, dangerSoft, dangerLine)
    "violet" -> StatusTint(violet, violetSoft, violetLine)
    else -> StatusTint(idle, idleSoft, idleLine)
}

/** statusColor mapping (tokens `statusColor`, doc 01 §2) — the binding contract. */
fun statusColorName(status: String, domain: StatusDomain): String {
    val s = status.lowercase()
    return when (domain) {
        StatusDomain.Task -> when (s) {
            "pending", "not_ready" -> "idle"
            "ready" -> "info"
            "in_progress" -> "accent"
            "blocked" -> "warn"
            "needs_verification" -> "violet"
            "completed" -> "ok"
            "cancelled" -> "danger"
            else -> "idle"
        }
        StatusDomain.Request -> when (s) {
            "open" -> "info"
            "accepted" -> "accent"
            "rejected" -> "danger"
            "answered", "converted_to_task" -> "violet"
            "closed" -> "idle"
            else -> "idle"
        }
        StatusDomain.Agent -> when (s) {
            "working" -> "accent"
            "blocked" -> "warn"
            "awaiting_request" -> "info"
            "awaiting_human" -> "violet"
            "terminated" -> "danger"
            else -> "idle"
        }
        StatusDomain.Connection -> when (s) {
            "live", "active" -> "ok"
            "polling", "paused" -> "warn"
            "unreachable", "failed", "off" -> "danger"
            else -> "idle"
        }
        StatusDomain.Run -> when (s) {
            "running" -> "accent"
            "exited", "finished" -> "ok"
            "killed", "failed", "error" -> "danger"
            "stopped" -> "idle"
            else -> "idle"
        }
    }
}

/** Statuses whose pill dot pulses (portal `.pill.s-working` parity). */
private fun pulses(status: String, domain: StatusDomain): Boolean {
    val s = status.lowercase()
    return (domain == StatusDomain.Agent && s == "working") ||
        (domain == StatusDomain.Run && s == "running") ||
        (domain == StatusDomain.Connection && (s == "live" || s == "active")) ||
        (domain == StatusDomain.Task && s == "in_progress")
}

/** Sharp square corners in Swiss (mono), full capsule otherwise — iOS `PillShape` parity. */
private fun pillShape(mono: Boolean): RoundedCornerShape =
    RoundedCornerShape(if (mono) 0.dp else 999.dp)

/** Swiss uppercases + widens tracking on mono pill text — iOS `pillLabel`/`pillTracking` parity. */
@Composable
private fun pillTextStyle(mono: Boolean): androidx.compose.ui.text.TextStyle {
    val base = MaterialTheme.typography.labelMedium
    return if (mono) {
        base.copy(fontFamily = MonoFontFamily, letterSpacing = 0.7.sp, fontSize = 10.sp)
    } else {
        base
    }
}

private fun pillLabel(text: String, mono: Boolean): String = if (mono) text.uppercase() else text

/**
 * The status pill — `.pill` in the mockup kit: word + dot, color text on Soft fill with
 * Line border, 11/700, radius 999, padding 3/10/3/8, 7dp dot. Status is never conveyed
 * by color alone: the word always renders (foundations §2 accessibility). Swiss
 * (`palette.pillMono`) squares the pill off and sets the label in uppercase mono, iOS
 * `StatusPill`/`PillShape` parity.
 */
@Composable
fun StatusPill(status: String, domain: StatusDomain, modifier: Modifier = Modifier) {
    val palette = Orcha.palette
    val tint = palette.tint(statusColorName(status, domain))
    val mono = palette.pillMono
    val shape = pillShape(mono)
    val copy = pillLabel(MobileUx.statusCopy(status.lowercase()), mono)
    Row(
        modifier = modifier
            .background(tint.soft, shape)
            .border(BorderStroke(1.dp, tint.line), shape)
            .padding(start = 8.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val dotAlpha = if (pulses(status, domain)) pulseAlpha() else 1f
        Box(Modifier.size(7.dp).alpha(dotAlpha).background(tint.color, CircleShape))
        Text(copy, color = tint.color, style = pillTextStyle(mono))
    }
}

/** 2s ease-in-out opacity pulse (css `@keyframes pulse`: 1 → .35 → 1). */
@Composable
fun pulseAlpha(): Float {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 2000
                1f at 0
                0.35f at 1000
                1f at 2000
            },
            repeatMode = RepeatMode.Restart,
        ),
        label = "pulseAlpha",
    )
    return alpha
}

/**
 * Request-status pill with a status GLYPH (web STAT/glyph parity, app.js:320-353):
 * open=warning-triangle, accepted=play, answered=check, rejected=✕, converted=arrow,
 * closed=neutral dot. `escalated` (an OPEN human-targeted request, requests.html:135)
 * relabels the pill and tints it danger. Tints stay on the app's binding token map.
 */
@Composable
fun RequestStatusPill(status: String, escalated: Boolean = false, modifier: Modifier = Modifier) {
    val palette = Orcha.palette
    val mono = palette.pillMono
    val shape = pillShape(mono)
    val shown = if (escalated && status.lowercase() == "open") "escalated" else status.lowercase()
    val tint = palette.tint(if (shown == "escalated") "danger" else statusColorName(status, StatusDomain.Request))
    val icon: androidx.compose.ui.graphics.vector.ImageVector? = when (shown) {
        "open" -> OrchaIcons.WarningAmber
        "accepted" -> OrchaIcons.PlayArrow
        "answered" -> OrchaIcons.Check
        "rejected", "escalated" -> OrchaIcons.Close
        "converted_to_task" -> OrchaIcons.ArrowForward
        else -> null // closed & unknown keep the neutral dot
    }
    Row(
        modifier = modifier
            .background(tint.soft, shape)
            .border(BorderStroke(1.dp, tint.line), shape)
            .padding(start = 8.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = tint.color, modifier = Modifier.size(12.dp))
        } else {
            Box(Modifier.size(7.dp).background(tint.color, CircleShape))
        }
        Text(pillLabel(MobileUx.statusCopy(shown), mono), color = tint.color, style = pillTextStyle(mono))
    }
}

/** Back-compat alias used across screens. */
fun statusCopy(status: String): String = MobileUx.statusCopy(status)

@Suppress("unused")
private val easing = LinearEasing
