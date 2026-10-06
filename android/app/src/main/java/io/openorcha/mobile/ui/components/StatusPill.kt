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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
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
    val base = ltype(LType.Meta).copy(fontSize = 12.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
    return if (mono) {
        base.copy(fontFamily = MonoFontFamily, letterSpacing = 0.7.sp, fontSize = 10.sp)
    } else {
        base
    }
}

private fun pillLabel(text: String, mono: Boolean): String = if (mono) text.uppercase() else text

/**
 * Request status → the status the glyph draws. The web `StatusIcon` has a glyph for every
 * request status (open, accepted, answered, closed, rejected, escalated, converted_to_task),
 * so the request status is drawn as itself — no remapping onto task glyphs.
 */
internal fun requestGlyphStatus(shown: String): String = shown.lowercase()

/** Task / request / agent statuses show the web glyph + label; connection / run keep the dot. */
internal fun statusPillUsesGlyph(domain: StatusDomain): Boolean =
    domain == StatusDomain.Task || domain == StatusDomain.Request || domain == StatusDomain.Agent

/** Neutral Linear pill shell: hairline border, transparent fill, compact. */
@Composable
private fun LinearPillShell(mono: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    val p = Orcha.palette
    val shape = pillShape(mono)
    Row(
        modifier = modifier
            .background(p.surface2, shape)
            .border(BorderStroke(1.dp, p.border), shape)
            .padding(start = 6.dp, end = 8.dp, top = 2.dp, bottom = 2.dp)
            .semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) { content() }
}

/**
 * The status pill, Linear style: the web status glyph (tasks / requests / agents) or a
 * tinted presence dot (connections / runs) + the word in text2, on a neutral hairline pill.
 * Status is never conveyed by colour alone: the word always renders. Swiss
 * (`palette.pillMono`) squares the pill off and sets the label in uppercase mono.
 */
@Composable
fun StatusPill(status: String, domain: StatusDomain, modifier: Modifier = Modifier) {
    val palette = Orcha.palette
    val tint = palette.tint(statusColorName(status, domain))
    val mono = palette.pillMono
    val usesGlyph = statusPillUsesGlyph(domain)
    val copy = pillLabel(if (usesGlyph) lStatusLabel(status) else MobileUx.statusCopy(status.lowercase()), mono)
    LinearPillShell(mono, modifier) {
        if (usesGlyph) {
            LStatusGlyph(status, size = 12.dp, modifier = Modifier.clearAndSetSemantics { })
        } else {
            val dotAlpha = if (pulses(status, domain)) pulseAlpha() else 1f
            Box(Modifier.size(7.dp).alpha(dotAlpha).background(tint.color, CircleShape))
        }
        Text(copy, color = palette.text2, style = pillTextStyle(mono))
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
 * The same pulse as a modifier that reads the animation in the draw phase, so the
 * pulsing element redraws each frame without recomposing (unlike `alpha(pulseAlpha())`).
 */
@Composable
fun Modifier.pulsing(): Modifier {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha = transition.animateFloat(
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
        label = "pulsing",
    )
    return this.graphicsLayer { this.alpha = alpha.value }
}

/**
 * Request-status pill: the web `StatusIcon` glyph + label for the request status.
 * `escalated` (an OPEN human-targeted request) shows the web escalated glyph
 * (red ring + up arrow) labelled "Escalated".
 */
@Composable
fun RequestStatusPill(status: String, escalated: Boolean = false, modifier: Modifier = Modifier) {
    val palette = Orcha.palette
    val mono = palette.pillMono
    val shown = if (escalated && status.lowercase() == "open") "escalated" else status.lowercase()
    LinearPillShell(mono, modifier) {
        LStatusGlyph(requestGlyphStatus(shown), size = 12.dp, modifier = Modifier.clearAndSetSemantics { })
        Text(pillLabel(lStatusLabel(shown), mono), color = palette.text2, style = pillTextStyle(mono))
    }
}

/** Back-compat alias used across screens. */
fun statusCopy(status: String): String = MobileUx.statusCopy(status)

@Suppress("unused")
private val easing = LinearEasing
