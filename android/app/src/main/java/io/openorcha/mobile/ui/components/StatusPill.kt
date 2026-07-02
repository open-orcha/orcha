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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.OrchaPalette
import androidx.compose.ui.unit.dp

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

/**
 * The status pill — `.pill` in the mockup kit: word + dot, color text on Soft fill with
 * Line border, 11/700, radius 999, padding 3/10/3/8, 7dp dot. Status is never conveyed
 * by color alone: the word always renders (foundations §2 accessibility).
 */
@Composable
fun StatusPill(status: String, domain: StatusDomain, modifier: Modifier = Modifier) {
    val tint = Orcha.palette.tint(statusColorName(status, domain))
    val copy = MobileUx.statusCopy(status.lowercase())
    Row(
        modifier = modifier
            .background(tint.soft, RoundedCornerShape(999.dp))
            .border(BorderStroke(1.dp, tint.line), RoundedCornerShape(999.dp))
            .padding(start = 8.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val dotAlpha = if (pulses(status, domain)) pulseAlpha() else 1f
        Box(Modifier.size(7.dp).alpha(dotAlpha).background(tint.color, CircleShape))
        Text(copy, color = tint.color, style = MaterialTheme.typography.labelMedium)
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

/** Back-compat alias used across screens. */
fun statusCopy(status: String): String = MobileUx.statusCopy(status)

@Suppress("unused")
private val easing = LinearEasing
